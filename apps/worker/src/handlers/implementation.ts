import { AppError } from '@ai-engine/shared';
import type { QaFinding } from '@ai-engine/domain';
import { conversationTranscript, loadAgentPrompt, runImplementationAgent } from '@ai-engine/agents';
import { ConflictEngine } from '@ai-engine/conflict-engine';
import { changedFiles, GitClient } from '@ai-engine/git';
import {
  buildProjectContext,
  createAiProvider,
  createToolEnvironment,
  resolveAgentVersion,
  workspacePathFor,
  type JobContext,
} from '../job-context';
import { SandboxClient } from '../sandbox-client';

async function approvedReviewDocument(context: JobContext) {
  const versionId = await context.repos.approvals.findApprovedReviewVersionId(context.task.id);
  if (!versionId) {
    throw new AppError('not_approved', 'This task has no approved review, so implementation cannot start', 409);
  }
  return context.repos.reviews.getVersion(versionId);
}

/** Findings the QA agent raised in the previous iteration and are still open. */
async function openQaFindings(context: JobContext): Promise<QaFinding[]> {
  const latest = await context.repos.qaRuns.latest(context.task.id);
  if (!latest || latest.verdict === 'APPROVED') return [];
  return latest.findings;
}

/**
 * Runs the implementation agent inside a writable sandbox. Everything it does
 * stays in the task worktree; nothing is pushed and nothing touches the
 * developer's working copy.
 */
export async function handleImplementation(context: JobContext, mode: 'IMPLEMENTATION' | 'FIX'): Promise<void> {
  const sandbox = new SandboxClient(context.project.repoPath);

  await sandbox.ensure({
    taskId: context.task.id,
    branch: context.task.branchName,
    baseCommit: context.task.baseCommit,
    mode: 'READ_WRITE',
  });
  await sandbox.setMode(context.task.id, 'READ_WRITE');

  await context.orchestrator.transition({
    taskId: context.task.id,
    to: mode === 'FIX' ? 'FIXING' : 'IMPLEMENTING',
    actor: { type: 'worker', id: context.workerId },
  });

  const approved = await approvedReviewDocument(context);
  const qaFindings = mode === 'FIX' ? await openQaFindings(context) : [];
  const provider = createAiProvider();
  const projectContext = await buildProjectContext(context);
  const manifest = await context.repos.runtimeManifests.latest(context.project.id);

  const prompt = await loadAgentPrompt('implementation', context.project.repoPath);
  const agentVersionId = await resolveAgentVersion(context, 'implementation', prompt);
  const run = await context.repos.runs.start({
    taskId: context.task.id,
    phase: 'IMPLEMENTATION',
    agentType: 'implementation',
    agentVersionId,
  });

  try {
    const { registry, toolContext } = await createToolEnvironment({
      context,
      runId: run.id,
      phase: 'IMPLEMENTATION',
      allowWeb: false,
    });

    const { outcome, loop } = await runImplementationAgent({
      provider,
      registry,
      toolContext,
      projectContext,
      story: context.story,
      revision: context.revision,
      task: context.task,
      approvedReview: approved.document,
      runtimeManifest: manifest?.manifest ?? null,
      projectRoot: context.project.repoPath,
      ...(qaFindings.length > 0 ? { qaFindings, qaIteration: context.task.qaIteration } : {}),
      logger: context.logger,
    });

    await context.artifacts.put({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: run.id,
      kind: 'implementation_outcome',
      contentType: 'application/json',
      content: JSON.stringify(outcome, null, 2),
    });
    await context.artifacts.put({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: run.id,
      kind: 'implementation_transcript',
      contentType: 'text/markdown',
      content: conversationTranscript(loop.messages),
    });

    // The implementation may have discovered impact the review did not predict.
    const conflicts = new ConflictEngine(context.db);
    if (outcome.impactedResources.length > 0) {
      await conflicts.updateImpact(
        context.task.id,
        outcome.impactedResources.map((resource) => ({
          kind: resource.kind as never,
          identifier: resource.identifier,
          access: resource.access,
          source: 'implementation' as const,
        })),
      );
    }

    const git = new GitClient(workspacePathFor(context.task.id));
    const changes = await changedFiles(git, context.task.baseCommit);
    await context.repos.gitChanges.replaceForTask(
      context.task.id,
      changes.map((change) => ({
        filePath: change.filePath,
        changeType: change.changeType,
        insertions: change.insertions,
        deletions: change.deletions,
      })),
    );
    for (const change of changes) {
      await context.events.append({
        projectId: context.project.id,
        taskId: context.task.id,
        runId: run.id,
        eventType: 'FileModified',
        actorType: 'agent',
        actorId: 'implementation',
        payload: { path: change.filePath, changeType: change.changeType },
      });
    }

    await context.repos.runs.complete(run.id, loop.usage);
    await context.orchestrator.checkpoint({
      taskId: context.task.id,
      runId: run.id,
      gitHead: await git.headCommit().catch(() => null),
      workspaceMetadata: { changedFiles: changes.length },
    });

    // An agent may never quietly widen the approved intent.
    const blocking = outcome.discoveredIssues.filter((issue) => issue.requiresSupplementalReview);
    if (blocking.length > 0) {
      await createSupplementalReview(context, blocking);
      await context.orchestrator.block(
        context.task.id,
        `The implementation found work outside the approved plan: ${blocking.map((issue) => issue.title).join('; ')}`,
        { type: 'agent', id: 'implementation' },
      );
      return;
    }

    await context.orchestrator.transition({
      taskId: context.task.id,
      to: 'QA_QUEUED',
      actor: { type: 'worker', id: context.workerId },
      enqueue: { jobType: 'QA' },
      payload: { changedFiles: changes.length },
    });
  } catch (error) {
    await context.repos.runs.fail(run.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Records the discovered work as a supplemental review for a human decision. */
async function createSupplementalReview(
  context: JobContext,
  issues: { title: string; detail: string }[],
): Promise<void> {
  const review = await context.repos.reviews.create(context.task.id, 'SUPPLEMENTAL');
  const document = {
    summary: `The implementation discovered work that the approved plan does not cover: ${issues
      .map((issue) => issue.title)
      .join('; ')}`,
    sections: [
      {
        key: 'open_decisions' as const,
        title: 'Open Decisions / Blocking Questions',
        body: issues.map((issue) => `- **${issue.title}**: ${issue.detail}`).join('\n'),
      },
    ],
    implementationSteps: [],
    expectedFiles: [],
    expectedSymbols: [],
    riskSignals: [],
    openQuestions: issues.map((issue) => issue.title),
  };
  await context.repos.reviews.addVersion({
    reviewId: review.id,
    document,
    markdown: `# Supplemental Review\n\n${document.summary}\n\n${document.sections[0]!.body}`,
  });
  await context.events.append({
    projectId: context.project.id,
    taskId: context.task.id,
    eventType: 'SupplementalReviewCreated',
    actorType: 'agent',
    actorId: 'implementation',
    payload: { reviewId: review.id, issues: issues.length },
  });
}
