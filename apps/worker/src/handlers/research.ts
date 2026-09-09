import { renderReviewMarkdown } from '@ai-engine/domain';
import {
  loadAgentPrompt,
  renderResearchFindings,
  runResearchAgent,
  runReviewAgent,
  validateResearchFindings,
  type AgentRunOutcome,
} from '@ai-engine/agents';
import { impactFromReview, ConflictEngine } from '@ai-engine/conflict-engine';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import {
  buildProjectContext,
  createAgentRunner,
  recordEngineMetrics,
  resolveAgentVersion,
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
    context.logger.info('reusing the research findings from an earlier attempt', { artifactId: existing.id });
    const findings = validateResearchFindings(JSON.parse(await context.artifacts.getText(existing.id)));
    await generateReview(context, { projectContext, findings, previousReview: null });
    return;
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
    await context.repos.runs.complete(researchRun.id, outcome.usage);
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
    const runner = await createAgentRunner({ context, runId: reviewRun.id, phase: 'REVIEW' });

    const { document, outcome, problems } = await runReviewAgent({
      runner,
      projectContext: input.projectContext,
      story: context.story,
      revision: context.revision,
      task: context.task,
      findings: input.findings,
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
    await context.repos.runs.complete(reviewRun.id, outcome.usage);
    await recordEngineMetrics(context, 'review', outcome);

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
