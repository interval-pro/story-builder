import { loadConfig } from '@ai-engine/shared';
import { renderReviewMarkdown } from '@ai-engine/domain';
import {
  loadAgentPrompt,
  renderResearchFindings,
  runResearchAgent,
  runReviewAgent,
  validateResearchFindings,
  type AgentRunOutcome,
} from '@ai-engine/agents';
import { classifyTaskSize } from '@ai-engine/domain';
import { impactFromReview, ConflictEngine } from '@ai-engine/conflict-engine';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import {
  buildProjectContext,
  createAgentRunner,
  recordEngineMetrics,
  resolveAgentVersion,
  runCompletion,
  taskArtifactsPathFor,
  type JobContext,
} from '../job-context';
import { SandboxClient } from '../sandbox-client';

/**
 * Research and the first engineering review run as one job: the review is
 * worthless without the findings, and keeping them together means one
 * checkpoint instead of two half-states.
 */
export async function handleResearch(context: JobContext): Promise<void> {
  const sandbox = new SandboxClient(context.project.repoPath);

  await sandbox.ensure({
    taskId: context.task.id,
    branch: context.task.branchName,
    baseCommit: context.task.baseCommit,
    mode: 'READ_ONLY',
  });

  await context.orchestrator.ensureState({
    taskId: context.task.id,
    to: 'ANALYZING',
    actor: { type: 'worker', id: context.workerId },
  });

  // Knowledge is bound to the base commit, so a task keeps a stable picture.
  if (!context.task.knowledgeSnapshotId) {
    const knowledge = new KnowledgeService(context.db);
    const { snapshot } = await knowledge.buildSnapshot({
      projectId: context.project.id,
      gitCommit: context.task.baseCommit,
      repositoryPath: context.project.repoPath,
    });
    await context.repos.tasks.update(context.task.id, { knowledgeSnapshotId: snapshot.id });
    context.task.knowledgeSnapshotId = snapshot.id;
    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      eventType: 'KnowledgeSnapshotCreated',
      actorType: 'worker',
      actorId: context.workerId,
      payload: { snapshotId: snapshot.id, commit: context.task.baseCommit },
    });
  }

  const projectContext = await buildProjectContext(context);

  // A retry after an interruption reuses the findings that were already paid
  // for, and continues with the review instead of researching the same commit
  // a second time.
  const existing = await context.repos.artifacts.latestByKind(context.task.id, 'research_findings_json');
  if (existing) {
    // Reuse is an optimisation, never a requirement. If the earlier findings
    // cannot be read back the task researches again rather than failing on
    // every retry with the same unreadable artifact.
    try {
      const findings = validateResearchFindings(JSON.parse(await context.artifacts.getText(existing.id)));
      context.logger.info('reusing the research findings from an earlier attempt', { artifactId: existing.id });
      await generateReview(context, { projectContext, findings, previousReview: null });
      return;
    } catch (error) {
      context.logger.warn('the earlier research findings could not be read, researching again', {
        artifactId: existing.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const researchPrompt = await loadAgentPrompt('research', context.installRoot);
  const researchVersionId = await resolveAgentVersion(context, 'research', researchPrompt);
  const researchRun = await context.repos.runs.start({
    taskId: context.task.id,
    phase: 'RESEARCH',
    agentType: 'research',
    agentVersionId: researchVersionId,
  });

  try {
    const runner = await createAgentRunner({ context, runId: researchRun.id, phase: 'RESEARCH' });

    const { findings, outcome } = await runResearchAgent({
      runner,
      projectContext,
      story: context.story,
      revision: context.revision,
      task: context.task,
      installRoot: context.installRoot,
    });

    await context.artifacts.put({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: researchRun.id,
      kind: 'research_findings',
      contentType: 'text/markdown',
      content: renderResearchFindings(findings),
    });
    // Stored as JSON so a later review regeneration can reuse the same findings.
    await context.artifacts.put({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: researchRun.id,
      kind: 'research_findings_json',
      contentType: 'application/json',
      content: JSON.stringify(findings, null, 2),
    });
    await context.artifacts.put({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: researchRun.id,
      kind: 'research_transcript',
      contentType: 'text/markdown',
      content: outcome.transcript,
    });
    await context.repos.runs.complete(researchRun.id, runCompletion(outcome));
    await recordEngineMetrics(context, 'research', outcome);
    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: researchRun.id,
      eventType: 'ResearchCompleted',
      actorType: 'agent',
      actorId: 'research',
      payload: { files: findings.relevantFiles.length, openQuestions: findings.openQuestions.length },
    });

    await generateReview(context, { projectContext, findings, previousReview: null });
  } catch (error) {
    await context.repos.runs.fail(researchRun.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Where the review agent can read the full findings. A regeneration resolves the
 * same file the first review was pointed at. Null when the findings have to be
 * inlined instead, which is either because no such artifact exists or because
 * the engine cannot reach one.
 *
 * Only the CLI engine can be handed a directory outside the worktree. The
 * built-in engine acts through the tool registry, whose read tools resolve every
 * path against the worktree and refuse anything outside it, and the artifact
 * store is a sibling of the workspaces root. Pointing that engine at the file
 * would deny the read on every review and quietly cost it the symbols, the
 * execution paths and the database, test, dependency and external notes.
 */
async function findingsArtifactPath(context: JobContext): Promise<string | null> {
  if (loadConfig().agents.engine !== 'claude-code') return null;

  const record = await context.repos.artifacts.latestByKind(context.task.id, 'research_findings');
  if (!record) {
    context.logger.warn('no research findings artifact to point the review at, sending them inline instead');
    return null;
  }
  return context.artifacts.localPath(record);
}

/**
 * The digest is a smaller prompt only if the agent reads the rest. A review that
 * skipped the read comes out thinner with nothing failing, so the skip is
 * recorded. This never fails the task: the review itself is still valid.
 */
async function checkFindingsWereRead(context: JobContext, runId: string, findingsPath: string): Promise<void> {
  const calls = await context.repos.toolCalls.listByRun(runId);
  const read = calls.some((call) => JSON.stringify(call.input).includes(findingsPath));
  if (read) return;

  context.logger.warn('the review agent never read the findings it was pointed at', { findingsPath });
  await context.repos.metrics.record({
    projectId: context.project.id,
    taskId: context.task.id,
    name: 'review_findings_unread',
    value: 1,
    labels: { agent: 'review' },
  });
}

/** Shared by the first review and every regeneration after human notes. */
export async function generateReview(
  context: JobContext,
  input: {
    projectContext: Awaited<ReturnType<typeof buildProjectContext>>;
    findings: Awaited<ReturnType<typeof runResearchAgent>>['findings'];
    previousReview: Parameters<typeof runReviewAgent>[0]['previousReview'] | null;
  },
): Promise<void> {
  const reviewPrompt = await loadAgentPrompt('review', context.installRoot);
  const reviewVersionId = await resolveAgentVersion(context, 'review', reviewPrompt);
  const reviewRun = await context.repos.runs.start({
    taskId: context.task.id,
    phase: 'REVIEW',
    agentType: 'review',
    agentVersionId: reviewVersionId,
  });

  try {
    const size = classifyTaskSize({
      fileCount: input.findings.relevantFiles.length,
      riskSignalCount: input.findings.riskSignals.length,
    });

    // The findings are already an artifact, so the prompt points at them instead
    // of carrying tens of kilobytes inline on every run and every regeneration.
    // The pointer and the directory that makes it readable come from one value,
    // so an agent is never told to read a file it would be refused.
    const findingsPath = await findingsArtifactPath(context);
    const runner = await createAgentRunner({
      context,
      runId: reviewRun.id,
      phase: 'REVIEW',
      size,
      ...(findingsPath ? { additionalDirectories: [taskArtifactsPathFor(context.project.id, context.task.id)] } : {}),
    });

    const { document, outcome, problems } = await runReviewAgent({
      runner,
      projectContext: input.projectContext,
      story: context.story,
      revision: context.revision,
      task: context.task,
      findings: input.findings,
      findingsPath,
      installRoot: context.installRoot,
      ...(input.previousReview ? { previousReview: input.previousReview } : {}),
    });

    if (problems.length > 0) {
      context.logger.warn('review document has gaps', { problems });
    }

    const review =
      (await context.repos.reviews.findCurrentForTask(context.task.id)) ??
      (await context.repos.reviews.create(context.task.id));
    const version = await context.repos.reviews.addVersion({
      reviewId: review.id,
      document,
      markdown: renderReviewMarkdown(document),
      generatedByRunId: reviewRun.id,
    });

    if (input.previousReview) {
      await context.repos.reviews.markNotesAddressed(
        review.id,
        input.previousReview.notes.map((note) => note.id),
      );
    }

    // The review's expected files and symbols are the first impact manifest.
    const conflicts = new ConflictEngine(context.db);
    await conflicts.updateImpact(context.task.id, impactFromReview(document.expectedFiles, document.expectedSymbols));

    await context.artifacts.put({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: reviewRun.id,
      kind: 'review_transcript',
      contentType: 'text/markdown',
      content: outcome.transcript,
    });
    await context.repos.runs.complete(reviewRun.id, runCompletion(outcome));
    await recordEngineMetrics(context, 'review', outcome);
    if (findingsPath) await checkFindingsWereRead(context, reviewRun.id, findingsPath);

    await context.orchestrator.transition({
      taskId: context.task.id,
      to: 'REVIEW_READY',
      actor: { type: 'agent', id: 'review' },
      payload: { reviewId: review.id, reviewVersionId: version.id, version: version.version, problems },
    });
    await context.orchestrator.checkpoint({ taskId: context.task.id, runId: reviewRun.id });
  } catch (error) {
    await context.repos.runs.fail(reviewRun.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
