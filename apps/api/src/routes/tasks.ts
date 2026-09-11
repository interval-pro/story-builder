import { HttpRouter, ValidationError } from '@ai-engine/shared';
import { deriveTaskProgress, SETTING_KEYS, totalTokens, transitionsFrom } from '@ai-engine/domain';
import { UNBLOCK_TARGETS, type UnblockTarget } from '@ai-engine/orchestrator';
import { assertCanApply, startApply } from '../apply';
import { actorFrom, resolveProjectId, requireBody, type ApiContext } from '../context';

/** Task state, execution progress and the human control actions. */
export function registerTaskRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/tasks', async ({ query }) => {
    // Omitting the project is how the overview asks for everything at once,
    // which is the point of one shared queue: seeing across projects.
    if (query.get('allProjects') === 'true') {
      return {
        tasks: await context.repos.tasks.listRunning(),
        waiting: await context.repos.tasks.listWaitingForHuman(),
      };
    }
    const projectId = await resolveProjectId(context, query.get('projectId'));
    const tasks = query.get('active') === 'true'
      ? await context.repos.tasks.listActive(projectId)
      : await context.repos.tasks.listByProjectWithStory(projectId);
    return { tasks };
  });

  router.get('/api/tasks/:id', async ({ params }) => {
    const task = await context.repos.tasks.getById(params['id']!);
    const story = await context.repos.stories.getById(task.storyId);
    const revision = await context.repos.stories.getRevision(task.storyRevisionId);
    const reviews = await context.repos.reviews.listByTask(task.id);
    const approvals = await context.repos.approvals.listByTask(task.id);
    const runs = await context.repos.runs.listByTask(task.id);
    const qaRuns = await context.repos.qaRuns.listByTask(task.id);
    const testRuns = await context.repos.testRuns.listByTask(task.id);
    const conflicts = await context.conflicts.openConflicts(task.id);
    const sandbox = await context.repos.sandboxes.findActiveByTask(task.id);
    const activeJob = await context.queue.findActiveForTask(task.id);
    const changes = await context.repos.gitChanges.listForTask(task.id);
    const project = await context.repos.projects.getById(task.projectId);
    const applies = await context.repos.installationApplies.findByTask(task.id);
    const currentReview = reviews.find((review) => review.kind === 'ENGINEERING' && review.status !== 'SUPERSEDED');
    const currentVersion = currentReview ? await context.repos.reviews.getLatestVersion(currentReview.id) : null;
    const decisions = currentVersion ? await context.repos.reviewDecisions.listForVersion(currentVersion.id) : [];

    return {
      task,
      decisions,
      // Across every review on this task, not only the engineering one: a
      // supplemental review opened because the implementation found work outside
      // the plan raises decisions too, and they are the reason the task stopped.
      openDecisions: await context.repos.reviewDecisions.listOpenForTask(task.id),
      // The fix-cycle limit as configured, not as hardcoded: the Checks tab draws
      // the remaining cycles from it, and drawing five when the setting says three
      // is a lie about how much room is left.
      maxQaIterations: await context.repos.settings.integer(SETTING_KEYS.maxQaIterations),
      project,
      applies,
      story,
      revision,
      reviews,
      approvals,
      runs,
      qaRuns,
      testRuns,
      conflicts,
      sandbox,
      activeJob,
      changes,
      allowedTransitions: transitionsFrom(task.state),
    };
  });

  /**
   * Where the task has got to, as a walk rather than a state name.
   *
   * Derived on the server because the derivation is domain logic, not a
   * presentation detail: the CLI shows the same walk, and two implementations of
   * it would disagree about what "done" means within a week.
   */
  router.get('/api/tasks/:id/progress', async ({ params }) => {
    const task = await context.repos.tasks.getById(params['id']!);
    const runs = await context.repos.runs.listByTask(task.id);
    const qaRuns = await context.repos.qaRuns.listByTask(task.id);
    const changes = await context.repos.gitChanges.listForTask(task.id);
    const approvedReviewVersionId = await context.repos.approvals.findApprovedReviewVersionId(task.id);
    const review = await context.repos.reviews.findCurrentForTask(task.id);
    const version = review ? await context.repos.reviews.getLatestVersion(review.id) : null;
    const openBlockingDecisions = version ? await context.repos.reviewDecisions.openBlockingCount(version.id) : 0;

    return {
      progress: deriveTaskProgress({
        state: task.state,
        previousState: task.previousState,
        qaIteration: task.qaIteration,
        blockedReason: task.blockedReason,
        failureReason: task.failureReason,
        runs,
        qaRuns,
        reviewApproved: Boolean(approvedReviewVersionId),
        openBlockingDecisions,
        changedFiles: changes.length,
      }),
    };
  });

  /**
   * What this task has used, in tokens, per run and per agent.
   *
   * Per run as well as per agent, because the question a person actually has is
   * which run was the expensive one, and an agent total hides a single run that
   * was forty per cent of the task.
   */
  router.get('/api/tasks/:id/usage', async ({ params }) => {
    const runs = await context.repos.runs.listByTask(params['id']!);
    const byAgent = new Map<string, { agentType: string; runs: number; tokens: number; unrecorded: number }>();
    let total = 0;
    let unrecorded = 0;

    for (const run of runs) {
      const tokens = totalTokens({
        inputTokens: run.inputTokens ?? 0,
        outputTokens: run.outputTokens ?? 0,
        cacheReadTokens: run.cacheReadTokens ?? 0,
        cacheCreationTokens: run.cacheCreationTokens ?? 0,
      });
      const nothingRecorded = run.inputTokens === null && run.outputTokens === null;
      total += tokens;
      if (nothingRecorded) unrecorded += 1;
      const bucket = byAgent.get(run.agentType) ?? { agentType: run.agentType, runs: 0, tokens: 0, unrecorded: 0 };
      bucket.runs += 1;
      bucket.tokens += tokens;
      if (nothingRecorded) bucket.unrecorded += 1;
      byAgent.set(run.agentType, bucket);
    }

    return {
      totalTokens: total,
      runs: runs.length,
      unrecordedRuns: unrecorded,
      byAgent: [...byAgent.values()],
      byRun: runs.map((run) => ({
        id: run.id,
        phase: run.phase,
        agentType: run.agentType,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cacheReadTokens: run.cacheReadTokens,
        cacheCreationTokens: run.cacheCreationTokens,
        totalTokens: totalTokens({
          inputTokens: run.inputTokens ?? 0,
          outputTokens: run.outputTokens ?? 0,
          cacheReadTokens: run.cacheReadTokens ?? 0,
          cacheCreationTokens: run.cacheCreationTokens ?? 0,
        }),
        // Null is "never recorded", which is not the same statement as a cold
        // start. Reporting the two as one was a defect the cockpit shipped.
        resumed: run.resumed,
        effort: run.effort,
        model: run.model,
        sessionId: run.sessionId,
        errorMessage: run.errorMessage,
      })),
    };
  });

  router.get('/api/tasks/:id/events', async ({ params, query }) => {
    const limit = Number.parseInt(query.get('limit') ?? '300', 10);
    return { events: await context.events.listByTask(params['id']!, limit) };
  });

  router.get('/api/tasks/:id/tool-calls', async ({ params, query }) => {
    const limit = Number.parseInt(query.get('limit') ?? '50', 10);
    return { toolCalls: await context.repos.toolCalls.listRecentByTask(params['id']!, limit) };
  });

  router.get('/api/tasks/:id/artifacts', async ({ params, query }) => {
    const kind = query.get('kind');
    return { artifacts: await context.repos.artifacts.listByTask(params['id']!, kind ?? undefined) };
  });

  router.get('/api/tasks/:id/checkpoints', async ({ params }) => {
    return { checkpoints: await context.repos.checkpoints.listByTask(params['id']!) };
  });

  router.get('/api/tasks/:id/final-report', async ({ params }) => {
    const artifact = await context.repos.artifacts.latestByKind(params['id']!, 'final_report');
    if (!artifact) return { report: null };
    return { report: await context.artifacts.getText(artifact.id), artifact };
  });

  /**
   * Applies a finished installation task to the engine. Everything stops while
   * it runs, including this process, so the work is handed to a detached
   * process and the answer here only says that it started.
   */
  /**
   * Applies a finished installation task to the engine. Everything stops while
   * it runs, including this process, so the work is handed to a detached
   * process and the answer here only says that it started.
   */
  router.post('/api/tasks/:id/apply', async ({ params }) => {
    const task = await context.repos.tasks.getById(params['id']!);
    const project = await context.repos.projects.getById(task.projectId);
    if (project.kind !== 'INSTALLATION') {
      throw new ValidationError('Only a task against the installation can be applied to it');
    }
    if (task.state !== 'COMPLETED') {
      throw new ValidationError(`The task is ${task.state}. Only a completed task can be applied.`);
    }

    await assertCanApply(context, project);
    const record = await startApply(context, {
      installation: project,
      taskId: task.id,
      source: 'TASK',
      candidateRef: task.branchName,
    });
    return { applyId: record.id, status: record.status, candidateRef: record.candidateRef };
  });

  router.post('/api/tasks/:id/pause', async ({ params, headers }) => {
    return { task: await context.commands.pause(params['id']!, actorFrom(headers as Record<string, unknown>)) };
  });

  router.post('/api/tasks/:id/resume', async ({ params, headers }) => {
    return { task: await context.commands.resume(params['id']!, actorFrom(headers as Record<string, unknown>)) };
  });

  router.post('/api/tasks/:id/stop', async ({ params, headers }) => {
    return { task: await context.commands.stop(params['id']!, actorFrom(headers as Record<string, unknown>)) };
  });

  router.post('/api/tasks/:id/retry', async ({ params, headers }) => {
    return { task: await context.commands.retry(params['id']!, actorFrom(headers as Record<string, unknown>)) };
  });

  router.post('/api/tasks/:id/unblock', async ({ params, body, headers }) => {
    const input = requireBody<{ target: UnblockTarget }>(body, ['target']);
    if (!UNBLOCK_TARGETS.includes(input.target)) {
      throw new ValidationError(`target must be one of ${UNBLOCK_TARGETS.join(', ')}`);
    }
    return {
      task: await context.commands.unblock({
        taskId: params['id']!,
        target: input.target,
        actor: actorFrom(headers as Record<string, unknown>),
      }),
    };
  });

  /**
   * Answers one decision on the plan.
   *
   * 'custom' carries the person's own words. 'agent' hands the choice back with
   * the reasons stated, which is itself a decision and is recorded as one rather
   * than left looking unanswered.
   */
  router.post('/api/tasks/:id/decisions/:key', async ({ params, body, headers }) => {
    const input = requireBody<{ chosenKey: string; customAnswer?: string }>(body, ['chosenKey']);
    return context.commands.answerDecision({
      taskId: params['id']!,
      key: params['key']!,
      chosenKey: input.chosenKey,
      ...(input.customAnswer ? { customAnswer: input.customAnswer } : {}),
      actor: actorFrom(headers as Record<string, unknown>),
    });
  });
}
