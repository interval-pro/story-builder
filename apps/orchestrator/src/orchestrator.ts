import { AppError, createLogger, type Logger } from '@ai-engine/shared';
import {
  assertTransition,
  isTerminal,
  phaseForState,
  type JobType,
  type Task,
  type TaskState,
} from '@ai-engine/domain';
import { createRepositories, type Database, type Queryable, type Repositories } from '@ai-engine/db';
import { EventLog } from '@ai-engine/events';
import { JobQueue } from '@ai-engine/queue';
import type { ActorType, EventType } from '@ai-engine/domain';

export interface Actor {
  type: ActorType;
  id: string;
}

export interface TransitionInput {
  taskId: string;
  to: TaskState;
  actor: Actor;
  reason?: string;
  payload?: Record<string, unknown>;
  /** Job to enqueue in the same transaction as the transition. */
  enqueue?: { jobType: JobType; payload?: Record<string, unknown> };
  /** Fields to update on the task alongside the transition. */
  patch?: Parameters<Repositories['tasks']['update']>[1];
}

const STATE_EVENTS: Partial<Record<TaskState, EventType>> = {
  ANALYZING: 'AnalysisStarted',
  REVIEW_READY: 'ReviewGenerated',
  REVIEW_REGENERATING: 'ReviewRegenerated',
  REVIEW_APPROVED: 'ReviewApproved',
  IMPLEMENTING: 'ImplementationStarted',
  QA_RUNNING: 'QAStarted',
  FIXING: 'FixStarted',
  BLOCKED: 'TaskBlocked',
  FINAL_REVIEW_READY: 'FinalReviewGenerated',
  PR_CREATED: 'PRCreated',
  COMPLETED: 'TaskCompleted',
  PAUSED: 'TaskPaused',
  STOPPED: 'TaskStopped',
  FAILED: 'TaskFailed',
};

/**
 * The only component allowed to change task state. Every transition, its event
 * and the job that continues the work are written in one database transaction,
 * which is what makes a crash recoverable rather than corrupting.
 */
export class Orchestrator {
  private readonly logger: Logger;

  constructor(private readonly db: Database, logger?: Logger) {
    this.logger = logger ?? createLogger('orchestrator');
  }

  private repositories(tx: Queryable): { repos: Repositories; events: EventLog; queue: JobQueue } {
    return { repos: createRepositories(tx), events: new EventLog(tx), queue: new JobQueue(tx) };
  }

  async transition(input: TransitionInput): Promise<Task> {
    return this.db.transaction(async (tx) => {
      const { repos, events, queue } = this.repositories(tx);
      const current = await repos.tasks.getByIdForUpdate(input.taskId);
      assertTransition(current.state, input.to);

      if (input.patch) await repos.tasks.update(current.id, input.patch);
      const task = await repos.tasks.setState(current.id, current.state, input.to);

      await events.append({
        projectId: task.projectId,
        taskId: task.id,
        eventType: 'TaskStateChanged',
        actorType: input.actor.type,
        actorId: input.actor.id,
        payload: { from: current.state, to: input.to, reason: input.reason ?? null, ...input.payload },
      });

      const specific = STATE_EVENTS[input.to];
      if (specific) {
        await events.append({
          projectId: task.projectId,
          taskId: task.id,
          eventType: specific,
          actorType: input.actor.type,
          actorId: input.actor.id,
          payload: input.payload ?? {},
        });
      }

      // Pending work is dropped before anything new is queued, so a terminal
      // transition cannot cancel the follow-up job it just created.
      if (isTerminal(input.to)) {
        await queue.cancelPendingForTask(task.id);
      }

      if (input.enqueue) {
        await queue.enqueue({
          taskId: task.id,
          jobType: input.enqueue.jobType,
          payload: { taskId: task.id, ...input.enqueue.payload },
        });
      }

      this.logger.info('task transitioned', { taskId: task.id, from: current.state, to: input.to });
      return task;
    });
  }

  /** Records a checkpoint so a new worker can resume without the old context. */
  async checkpoint(input: {
    taskId: string;
    runId?: string | null;
    gitHead?: string | null;
    workspaceMetadata?: Record<string, unknown>;
    agentVersions?: Record<string, string>;
    planPosition?: number;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { repos, events } = this.repositories(tx);
      const task = await repos.tasks.getById(input.taskId);
      const checkpoint = await repos.checkpoints.create({
        taskId: task.id,
        runId: input.runId ?? null,
        state: task.state,
        gitHead: input.gitHead ?? null,
        workspaceMetadata: input.workspaceMetadata ?? {},
        agentVersions: input.agentVersions ?? {},
        knowledgeSnapshotId: task.knowledgeSnapshotId,
        planPosition: input.planPosition ?? 0,
      });
      await events.append({
        projectId: task.projectId,
        taskId: task.id,
        runId: input.runId ?? null,
        eventType: 'CheckpointCreated',
        actorType: 'orchestrator',
        actorId: 'orchestrator',
        payload: { checkpointId: checkpoint.id, state: task.state },
      });
    });
  }

  async fail(taskId: string, reason: string, actor: Actor = { type: 'orchestrator', id: 'orchestrator' }): Promise<Task> {
    const task = await createRepositories(this.db).tasks.getById(taskId);
    if (isTerminal(task.state)) return task;
    return this.transition({ taskId, to: 'FAILED', actor, reason, patch: { failureReason: reason } });
  }

  async block(taskId: string, reason: string, actor: Actor = { type: 'orchestrator', id: 'orchestrator' }): Promise<Task> {
    return this.transition({ taskId, to: 'BLOCKED', actor, reason, patch: { blockedReason: reason } });
  }

  /**
   * Periodic maintenance: reclaim jobs from dead workers, mark runs that were
   * interrupted, and fail tasks whose job exhausted its retries.
   */
  async tick(options: { jobLeaseSeconds: number }): Promise<{ reclaimed: number; failedTasks: number }> {
    const repos = createRepositories(this.db);
    const queue = new JobQueue(this.db);

    const reclaimed = await queue.reclaimExpired(options.jobLeaseSeconds);
    if (reclaimed.length > 0) {
      this.logger.warn('reclaimed expired jobs', { count: reclaimed.length });
    }
    await repos.runs.failStaleRuns(Math.max(30, Math.ceil(options.jobLeaseSeconds / 60)));

    const failedJobs = await this.db.query<{ task_id: string; last_error: string | null }>(
      `SELECT task_id, last_error FROM jobs j
       WHERE j.status = 'FAILED' AND j.task_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM jobs later
           WHERE later.task_id = j.task_id AND later.created_at > j.created_at
         )
         AND EXISTS (
           SELECT 1 FROM tasks t WHERE t.id = j.task_id AND t.state NOT IN ('FAILED', 'STOPPED', 'COMPLETED', 'ROLLED_BACK', 'BLOCKED', 'PAUSED')
         )`,
    );

    let failedTasks = 0;
    for (const row of failedJobs) {
      try {
        await this.fail(row.task_id, row.last_error ?? 'The job for this task failed after all retries');
        failedTasks++;
      } catch (error) {
        this.logger.error('could not fail task after job failure', { taskId: row.task_id, error });
      }
    }

    return { reclaimed: reclaimed.length, failedTasks };
  }

  /** Resume returns a paused task to the state it was paused from. */
  async resume(taskId: string, actor: Actor): Promise<Task> {
    const repos = createRepositories(this.db);
    const task = await repos.tasks.getById(taskId);
    if (task.state !== 'PAUSED') {
      throw new AppError('not_paused', `Task ${taskId} is not paused`, 409, { state: task.state });
    }
    const target = task.previousState ?? 'DRAFT';
    const phase = phaseForState(target);
    const jobType = phase ? JOB_FOR_PHASE[phase] : undefined;
    return this.transition({
      taskId,
      to: target,
      actor,
      reason: 'resumed by human',
      ...(jobType ? { enqueue: { jobType } } : {}),
    });
  }
}

const JOB_FOR_PHASE: Record<string, JobType> = {
  RESEARCH: 'RESEARCH',
  REVIEW: 'REVIEW_REGENERATE',
  IMPLEMENTATION: 'IMPLEMENTATION',
  QA: 'QA',
  FINAL_REPORT: 'FINAL_REPORT',
  INTEGRATION: 'INTEGRATION_VALIDATION',
  PUSH: 'PUSH_AND_PR',
};
