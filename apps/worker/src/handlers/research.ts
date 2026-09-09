import { renderReviewMarkdown } from '@ai-engine/domain';
import { conversationTranscript, loadAgentPrompt, renderResearchFindings, runResearchAgent, runReviewAgent } from '@ai-engine/agents';
import { impactFromReview, ConflictEngine } from '@ai-engine/conflict-engine';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import {
  buildProjectContext,
  createAiProvider,
  createToolEnvironment,
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

  await context.orchestrator.transition({
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

  const provider = createAiProvider();
  const projectContext = await buildProjectContext(context);

  const researchPrompt = await loadAgentPrompt('research', context.project.repoPath);
  const researchVersionId = await resolveAgentVersion(context, 'research', researchPrompt);
  const researchRun = await context.repos.runs.start({
    taskId: context.task.id,
    phase: 'RESEARCH',
    agentType: 'research',
    agentVersionId: researchVersionId,
  });

  try {
    const { registry, toolContext } = await createToolEnvironment({
      context,
      runId: researchRun.id,
      phase: 'RESEARCH',
    });

    const { findings, loop } = await runResearchAgent({
      provider,
      registry,
      toolContext,
      projectContext,
      story: context.story,
      revision: context.revision,
      task: context.task,
      projectRoot: context.project.repoPath,
      logger: context.logger,
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
      content: conversationTranscript(loop.messages),
    });
    await context.repos.runs.complete(researchRun.id, loop.usage);
    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: researchRun.id,
      eventType: 'ResearchCompleted',
      actorType: 'agent',
      actorId: 'research',
      payload: { files: findings.relevantFiles.length, openQuestions: findings.openQuestions.length },
    });

    await generateReview(context, {
      provider,
      projectContext,
      findings,
      previousReview: null,
    });
  } catch (error) {
    await context.repos.runs.fail(researchRun.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Shared by the first review and every regeneration after human notes. */
export async function generateReview(
  context: JobContext,
  input: {
    provider: ReturnType<typeof createAiProvider>;
    projectContext: Awaited<ReturnType<typeof buildProjectContext>>;
    findings: Awaited<ReturnType<typeof runResearchAgent>>['findings'];
    previousReview: Parameters<typeof runReviewAgent>[0]['previousReview'] | null;
  },
): Promise<void> {
  const reviewPrompt = await loadAgentPrompt('review', context.project.repoPath);
  const reviewVersionId = await resolveAgentVersion(context, 'review', reviewPrompt);
  const reviewRun = await context.repos.runs.start({
    taskId: context.task.id,
    phase: 'REVIEW',
    agentType: 'review',
    agentVersionId: reviewVersionId,
  });

  try {
    const { registry, toolContext } = await createToolEnvironment({
      context,
      runId: reviewRun.id,
      phase: 'REVIEW',
    });

    const { document, loop, problems } = await runReviewAgent({
      provider: input.provider,
      registry,
      toolContext,
      projectContext: input.projectContext,
      story: context.story,
      revision: context.revision,
      task: context.task,
      findings: input.findings,
      projectRoot: context.project.repoPath,
      ...(input.previousReview ? { previousReview: input.previousReview } : {}),
      logger: context.logger,
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
      content: conversationTranscript(loop.messages),
    });
    await context.repos.runs.complete(reviewRun.id, loop.usage);

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
