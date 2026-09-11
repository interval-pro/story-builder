import { AppError } from '@ai-engine/shared';
import {
  carryOpenFindings,
  classifyTaskSize,
  collectQaNotes,
  SETTING_KEYS,
  type QaFinding,
  type QaNote,
  type ReviewDocument,
} from '@ai-engine/domain';
import { loadAgentPrompt, runImplementationAgent } from '@ai-engine/agents';
import { ConflictEngine } from '@ai-engine/conflict-engine';
import { changedFiles, GitClient } from '@ai-engine/git';
import {
  buildProjectContext,
  createAgentRunner,
  commitWorkspace,
  ensureDependencies,
  failRun,
  recordEngineMetrics,
  recordSessionStart,
  resolveAgentVersion,
  resumableSessionFor,
  runCompletion,
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

/** The session id of the last implementation run, so a fix keeps its context. */
async function lastImplementationSession(context: JobContext): Promise<string | null> {
  const artifact = await context.repos.artifacts.latestByKind(context.task.id, 'implementation_transcript');
  const sessionId = artifact?.metadata['sessionId'];
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

/**
 * Everything QA has raised and nobody has resolved, plus its advisory notes.
 *
 * This used to read the latest QA run alone, which meant a new iteration erased
 * whatever the previous one found. Two passes over nearly the same diff produced
 * disjoint blocking findings, so that was not tidying up: a verified defect left
 * the record and shipped.
 */
async function openQaWork(context: JobContext): Promise<{ findings: QaFinding[]; notes: QaNote[] }> {
  const qaRuns = await context.repos.qaRuns.listByTask(context.task.id);
  if (qaRuns.length === 0) return { findings: [], notes: [] };

  // When an implementation ran between two QA runs, the later one judged changed
  // code. That is the only thing that lets a finding be treated as dealt with.
  const runs = await context.repos.runs.listByTask(context.task.id);
  const fixTimes = runs
    .filter((run) => run.phase === 'IMPLEMENTATION' && run.finishedAt)
    .map((run) => run.finishedAt as string);

  return {
    findings: carryOpenFindings({ qaRuns, fixTimes }),
    notes: collectQaNotes(qaRuns),
  };
}

/**
 * Whether a fix should continue the session that wrote the code.
 *
 * Continuing is far cheaper while the session is small: the repository has
 * already been read and the cached prefix is reused. It stops being cheaper when
 * the session has grown, because the bill is turns multiplied by context size, and
 * a session allowed to reach the size of the window is re-read on every turn. One
 * implementation run measured at 810k tokens of cache written and 53.8M read — the
 * equivalent of sixty-six full re-reads — and was forty per cent of an entire
 * task's cost on its own.
 *
 * Past the ceiling the fix starts cold from the approved plan and the open
 * findings, which is everything it actually needs.
 */
async function shouldContinueSession(context: JobContext): Promise<{ resume: boolean; size: number }> {
  const ceiling = await context.repos.settings.integer(SETTING_KEYS.implementationContextCeiling);
  const runs = await context.repos.runs.listByTask(context.task.id);
  const previous = runs.filter((run) => run.phase === 'IMPLEMENTATION').at(-1);
  // Cache creation is the honest measure of how big the conversation got: it is
  // what was written into the cache, which is the context that then gets read
  // back on every later turn.
  const size = previous?.cacheCreationTokens ?? 0;
  return { resume: size < ceiling, size };
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
  await ensureDependencies(context);

  await context.orchestrator.ensureState({
    taskId: context.task.id,
    to: mode === 'FIX' ? 'FIXING' : 'IMPLEMENTING',
    actor: { type: 'worker', id: context.workerId },
  });

  const approved = await approvedReviewDocument(context);
  const qaWork = mode === 'FIX' ? await openQaWork(context) : { findings: [], notes: [] };
  const qaFindings = qaWork.findings;
  const decisions = await context.repos.reviewDecisions.listAnswered(context.task.id);
  const projectContext = await buildProjectContext(context);
  const manifest = await context.repos.runtimeManifests.latest(context.project.id);

  const prompt = await loadAgentPrompt('implementation', context.installRoot);
  const agentVersionId = await resolveAgentVersion(context, 'implementation', prompt);

  // A run that failed recently takes precedence over the last transcript: it is
  // the newer session, and it is the one that still has the work in it.
  // A fix cycle otherwise continues the session that wrote the code originally,
  // but only while that session is still small enough to be worth continuing.
  const failedSessionId = await resumableSessionFor(context, 'IMPLEMENTATION');
  const continuation = await shouldContinueSession(context);
  if (mode === 'FIX' && !continuation.resume) {
    context.logger.info('starting the fix in a fresh session: the previous one had grown past the ceiling', {
      cacheCreationTokens: continuation.size,
    });
  }
  const previousSessionId =
    failedSessionId ??
    (mode === 'FIX' && continuation.resume ? await lastImplementationSession(context) : null);

  const run = await context.repos.runs.start({
    taskId: context.task.id,
    projectId: context.project.id,
    phase: 'IMPLEMENTATION',
    agentType: 'implementation',
    agentVersionId,
    sessionId: previousSessionId,
    ...(previousSessionId ? { resumed: true } : {}),
  });

  try {
    // Classified once by the review and held since; a task from before that was
    // recorded has none, so it is worked out here instead.
    const size =
      context.task.size ??
      classifyTaskSize({
        fileCount: approved.document.expectedFiles.length,
        riskSignalCount: approved.document.riskSignals.length,
      });
    const runner = await createAgentRunner({
      context,
      runId: run.id,
      phase: 'IMPLEMENTATION',
      allowWeb: false,
      size,
    });

    const { outcome, run: agentRun } = await runImplementationAgent({
      runner,
      projectContext,
      story: context.story,
      revision: context.revision,
      task: context.task,
      approvedReview: approved.document,
      runtimeManifest: manifest?.manifest ?? null,
      installRoot: context.installRoot,
      onSessionStart: recordSessionStart(context, run.id, Boolean(previousSessionId)),
      ...(qaFindings.length > 0 ? { qaFindings, qaIteration: context.task.qaIteration } : {}),
      ...(qaWork.notes.length > 0 ? { qaNotes: qaWork.notes } : {}),
      ...(decisions.length > 0 ? { decisions } : {}),
      ...(previousSessionId ? { resumeSessionId: previousSessionId } : {}),
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
      content: agentRun.transcript,
      metadata: { sessionId: agentRun.sessionId },
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

    await context.repos.runs.complete(run.id, runCompletion(agentRun));
    await recordEngineMetrics(context, 'implementation', agentRun);

    // The branch, not the worktree, is what survives. Without this a retry or a
    // fix would start again from the base commit.
    await commitWorkspace(context, git);

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
    await failRun(context, run.id, error);
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
    brief: {
      headline: 'The implementation found work the approved plan does not cover.',
      approach:
        'The task stopped rather than widening the plan on its own. Decide whether this work belongs ' +
        'in this story, and it resumes where it stopped.',
      changes: issues.map((issue) => issue.title),
      watchOut: [],
      effort: `${issues.length} discovered item(s)`,
    },
    decisions: issues.map((issue, index) => ({
      key: `discovered-${index + 1}`,
      question: issue.title,
      detail: issue.detail,
      blocking: true,
      options: [
        {
          key: 'include',
          label: 'Include it in this story',
          detail: 'The implementation continues and covers this as well.',
          consequence: 'This story grows, and the approved plan no longer describes all of it.',
          recommended: false,
        },
        {
          key: 'separate',
          label: 'Leave it for its own story',
          detail: 'The implementation finishes what was approved and this is recorded for later.',
          consequence: 'The change ships without this, which may be visible.',
          recommended: true,
        },
      ],
    })),
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
  } satisfies ReviewDocument;
  const version = await context.repos.reviews.addVersion({
    reviewId: review.id,
    document,
    markdown: `# Supplemental Review\n\n${document.summary}\n\n${document.sections[0]!.body}`,
  });
  // Rows, not just a document: a decision that only exists inside a JSON blob
  // cannot be gated on and cannot be answered with a click, which is the whole
  // reason the task stopped here rather than widening the plan by itself.
  await context.repos.reviewDecisions.replaceForVersion({
    taskId: context.task.id,
    reviewVersionId: version.id,
    decisions: document.decisions,
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
