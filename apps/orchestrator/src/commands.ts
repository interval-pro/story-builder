import { AppError, createLogger, newId, slugify } from '@ai-engine/shared';
import {
  classifyRisk,
  classifyTaskSize,
  requiresSecondApproval,
  type ProjectKind,
  type RiskSignal,
  type Story,
  type StoryRevision,
  type Task,
} from '@ai-engine/domain';
import { createRepositories, type Database } from '@ai-engine/db';
import { JobQueue } from '@ai-engine/queue';
import { EventLog } from '@ai-engine/events';
import { GitClient } from '@ai-engine/git';
import { ConflictEngine } from '@ai-engine/conflict-engine';
import { Orchestrator, type Actor } from './orchestrator';

const logger = createLogger('commands');

export interface CreateStoryInput {
  projectId: string;
  title?: string;
  body: string;
  actor: Actor;
  /** Start the analysis immediately instead of leaving the task in DRAFT. */
  startAnalysis?: boolean;
}

function deriveTitle(body: string): string {
  const firstLine = body.trim().split('\n')[0] ?? 'Untitled story';
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

/**
 * Human facing operations. The API calls these; they never change task state
 * directly, they go through the orchestrator.
 */
export class TaskCommands {
  private readonly orchestrator: Orchestrator;

  constructor(private readonly db: Database, orchestrator?: Orchestrator) {
    this.orchestrator = orchestrator ?? new Orchestrator(db);
  }

  async createStory(input: CreateStoryInput): Promise<{ story: Story; revision: StoryRevision; task: Task }> {
    const repos = createRepositories(this.db);
    const project = await repos.projects.getById(input.projectId);

    const git = new GitClient(project.repoPath);
    const baseBranch = project.defaultBranch;
    const baseCommit = (await git.resolveRef(baseBranch)) ?? (await git.headCommit());

    const created = await this.db.transaction(async (tx) => {
      const txRepos = createRepositories(tx);
      const events = new EventLog(tx);
      const { story, revision } = await txRepos.stories.create({
        projectId: project.id,
        title: input.title ?? deriveTitle(input.body),
        body: input.body,
      });

      const snapshot = await txRepos.knowledge.latestReady(project.id);
      const task = await txRepos.tasks.create({
        projectId: project.id,
        storyId: story.id,
        storyRevisionId: revision.id,
        branchName: `ai/story-${slugify(story.title)}-${story.id.slice(0, 8)}`,
        baseBranch,
        baseCommit,
        knowledgeSnapshotId: snapshot?.id ?? null,
      });

      await events.append({
        projectId: project.id,
        taskId: task.id,
        eventType: 'StoryCreated',
        actorType: input.actor.type,
        actorId: input.actor.id,
        payload: { storyId: story.id, title: story.title },
      });
      await events.append({
        projectId: project.id,
        taskId: task.id,
        eventType: 'StoryRevisionCreated',
        actorType: input.actor.type,
        actorId: input.actor.id,
        payload: { revision: revision.revision },
      });
      await events.append({
        projectId: project.id,
        taskId: task.id,
        eventType: 'TaskCreated',
        actorType: input.actor.type,
        actorId: input.actor.id,
        payload: { branchName: task.branchName, baseCommit },
      });

      return { story, revision, task };
    });

    logger.info('story created', { storyId: created.story.id, taskId: created.task.id, baseCommit });

    if (input.startAnalysis ?? true) {
      const task = await this.orchestrator.transition({
        taskId: created.task.id,
        to: 'ANALYSIS_QUEUED',
        actor: input.actor,
        enqueue: { jobType: 'RESEARCH' },
      });
      return { ...created, task };
    }
    return created;
  }

  /** A new story revision locks the old one and restarts the analysis. */
  async reviseStory(input: { taskId: string; body: string; actor: Actor }): Promise<{ revision: StoryRevision; task: Task }> {
    const repos = createRepositories(this.db);
    const task = await repos.tasks.getById(input.taskId);
    const revision = await repos.stories.addRevision(task.storyId, input.body, input.actor.id);
    const updated = await this.orchestrator.transition({
      taskId: task.id,
      to: 'ANALYSIS_QUEUED',
      actor: input.actor,
      reason: 'story revised',
      patch: { storyRevisionId: revision.id },
      enqueue: { jobType: 'RESEARCH', payload: { reason: 'story_revised' } },
    });
    return { revision, task: updated };
  }

  async addReviewNote(input: {
    taskId: string;
    reviewId: string;
    reviewVersionId: string;
    sectionKey?: string | null;
    anchorText: string;
    anchorStart?: number | null;
    anchorEnd?: number | null;
    note: string;
    actor: Actor;
  }): Promise<{ noteId: string }> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const events = new EventLog(tx);
      const task = await repos.tasks.getById(input.taskId);
      const note = await repos.reviews.addNote({
        reviewId: input.reviewId,
        reviewVersionId: input.reviewVersionId,
        sectionKey: input.sectionKey ?? null,
        anchorText: input.anchorText,
        anchorStart: input.anchorStart ?? null,
        anchorEnd: input.anchorEnd ?? null,
        note: input.note,
        createdBy: input.actor.id,
      });
      await events.append({
        projectId: task.projectId,
        taskId: task.id,
        eventType: 'HumanNoteAdded',
        actorType: input.actor.type,
        actorId: input.actor.id,
        payload: { noteId: note.id, sectionKey: input.sectionKey ?? null },
      });
      return { noteId: note.id };
    });
  }

  async regenerateReview(input: { taskId: string; actor: Actor }): Promise<Task> {
    const repos = createRepositories(this.db);
    const task = await repos.tasks.getById(input.taskId);
    const review = await repos.reviews.findCurrentForTask(task.id);
    if (!review) throw new AppError('no_review', 'This task has no review to regenerate', 409);
    const notes = await repos.reviews.listOpenNotes(review.id);
    if (notes.length === 0) {
      throw new AppError('no_notes', 'Add at least one note before regenerating the review', 400);
    }
    await this.orchestrator.transition({
      taskId: task.id,
      to: 'REVIEW_FEEDBACK_RECEIVED',
      actor: input.actor,
      payload: { noteCount: notes.length },
    });
    return this.orchestrator.transition({
      taskId: task.id,
      to: 'REVIEW_REGENERATING',
      actor: input.actor,
      enqueue: { jobType: 'REVIEW_REGENERATE' },
    });
  }

  /**
   * Approval is the gate that turns read-only analysis into write access.
   * High risk work needs a second, explicit execution approval after this one.
   */
  async approveReview(input: { taskId: string; comment?: string; actor: Actor }): Promise<Task> {
    const repos = createRepositories(this.db);
    const task = await repos.tasks.getById(input.taskId);
    const review = await repos.reviews.findCurrentForTask(task.id);
    if (!review) throw new AppError('no_review', 'This task has no review to approve', 409);
    const version = await repos.reviews.getLatestVersion(review.id);
    if (!version) throw new AppError('no_review_version', 'This review has no versions yet', 409);

    await repos.approvals.record({
      taskId: task.id,
      kind: 'REVIEW',
      reviewVersionId: version.id,
      decision: 'APPROVED',
      comment: input.comment ?? null,
      decidedBy: input.actor.id,
    });
    await repos.reviews.setStatus(review.id, 'APPROVED');

    const signals = version.document.riskSignals.map((signal) => ({
      indicator: signal.indicator,
      evidence: signal.evidence,
    })) as RiskSignal[];
    const risk = classifyRisk(signals);

    // Sized from the document the human just approved, the same document and the
    // same moment the risk level comes from. The review classified itself from
    // the research findings because that is all it had; implementation and QA
    // have always worked from the approved plan, so this is the number they get.
    const size = classifyTaskSize({
      fileCount: version.document.expectedFiles.length,
      riskSignalCount: version.document.riskSignals.length,
    });

    const approved = await this.orchestrator.transition({
      taskId: task.id,
      to: 'REVIEW_APPROVED',
      actor: input.actor,
      payload: { reviewVersionId: version.id, riskLevel: risk.level, size },
      patch: { riskLevel: risk.level, size },
    });

    if (requiresSecondApproval(risk.level)) {
      return this.orchestrator.transition({
        taskId: task.id,
        to: 'HIGH_RISK_CONFIRMATION_REQUIRED',
        actor: { type: 'orchestrator', id: 'orchestrator' },
        reason: risk.reason,
        payload: { signals: risk.signals },
      });
    }

    return this.startImplementation(approved.id, input.actor);
  }

  async confirmHighRisk(input: { taskId: string; comment?: string; actor: Actor }): Promise<Task> {
    const repos = createRepositories(this.db);
    await repos.approvals.record({
      taskId: input.taskId,
      kind: 'HIGH_RISK_EXECUTION',
      decision: 'APPROVED',
      comment: input.comment ?? null,
      decidedBy: input.actor.id,
    });
    return this.startImplementation(input.taskId, input.actor);
  }

  /** Checks conflicts and dependencies before letting the task write anything. */
  private async startImplementation(taskId: string, actor: Actor): Promise<Task> {
    const repos = createRepositories(this.db);
    const conflicts = new ConflictEngine(this.db);
    const blocking = await conflicts.blockingConflicts(taskId);
    if (blocking.length > 0) {
      return this.orchestrator.block(
        taskId,
        `Blocking conflicts with other active tasks: ${blocking.map((conflict) => conflict.resource).join(', ')}`,
        actor,
      );
    }
    if (await repos.dependencies.hasUnmetDependencies(taskId)) {
      return this.orchestrator.transition({
        taskId,
        to: 'WAITING_FOR_TASK',
        actor,
        reason: 'waiting for a dependency task to finish',
      });
    }
    return this.orchestrator.transition({
      taskId,
      to: 'IMPLEMENTATION_QUEUED',
      actor,
      enqueue: { jobType: 'IMPLEMENTATION' },
    });
  }

  async approvePullRequest(input: { taskId: string; comment?: string; actor: Actor }): Promise<Task> {
    const repos = createRepositories(this.db);
    await repos.approvals.record({
      taskId: input.taskId,
      kind: 'PR',
      decision: 'APPROVED',
      comment: input.comment ?? null,
      decidedBy: input.actor.id,
    });
    await this.orchestrator.transition({ taskId: input.taskId, to: 'PR_APPROVAL_REQUIRED', actor: input.actor });
    return this.orchestrator.transition({
      taskId: input.taskId,
      to: 'INTEGRATION_VALIDATION',
      actor: input.actor,
      enqueue: { jobType: 'INTEGRATION_VALIDATION' },
    });
  }

  async pause(taskId: string, actor: Actor): Promise<Task> {
    await this.orchestrator.transition({ taskId, to: 'PAUSING', actor, reason: 'paused by human' });
    return this.orchestrator.transition({ taskId, to: 'PAUSED', actor });
  }

  async resume(taskId: string, actor: Actor): Promise<Task> {
    return this.orchestrator.resume(taskId, actor);
  }

  async stop(taskId: string, actor: Actor): Promise<Task> {
    await this.orchestrator.transition({ taskId, to: 'STOPPING', actor, reason: 'stopped by human' });
    const task = await this.orchestrator.transition({ taskId, to: 'STOPPED', actor });
    await new ConflictEngine(this.db).releaseLocks(taskId);
    await new JobQueue(this.db).enqueue({
      taskId: null,
      jobType: 'SANDBOX_TEARDOWN',
      payload: { taskId },
    });
    return task;
  }

  /**
   * Restarts a failed task at the phase it should continue from. The handlers
   * reuse whatever they already produced, so a retry after an interruption
   * does not repeat work that was already paid for.
   */
  async retry(taskId: string, actor: Actor): Promise<Task> {
    const repos = createRepositories(this.db);
    const task = await repos.tasks.getById(taskId);
    if (task.state !== 'FAILED') {
      throw new AppError('not_failed', `Only a failed task can be retried, this one is ${task.state}`, 409);
    }

    const approvedReviewVersionId = await repos.approvals.findApprovedReviewVersionId(taskId);
    const qaRuns = await repos.qaRuns.listByTask(taskId);

    const target = !approvedReviewVersionId
      ? { state: 'ANALYSIS_QUEUED' as const, jobType: 'RESEARCH' as const }
      : qaRuns.length === 0
        ? { state: 'IMPLEMENTATION_QUEUED' as const, jobType: 'IMPLEMENTATION' as const }
        : { state: 'QA_QUEUED' as const, jobType: 'QA' as const };

    logger.info('retrying a failed task', { taskId, from: task.failureReason, to: target.state });
    return this.orchestrator.transition({
      taskId,
      to: target.state,
      actor,
      reason: 'retried by human',
      patch: { failureReason: null },
      enqueue: { jobType: target.jobType, payload: { reason: 'retry' } },
    });
  }

  /** Unblocks a task by sending it back to the phase the human chooses. */
  async unblock(input: { taskId: string; target: 'ANALYSIS_QUEUED' | 'IMPLEMENTATION_QUEUED' | 'FIX_REQUIRED'; actor: Actor }): Promise<Task> {
    const jobType = input.target === 'ANALYSIS_QUEUED' ? 'RESEARCH' : input.target === 'IMPLEMENTATION_QUEUED' ? 'IMPLEMENTATION' : 'FIX';
    return this.orchestrator.transition({
      taskId: input.taskId,
      to: input.target,
      actor: input.actor,
      reason: 'unblocked by human',
      patch: { blockedReason: null },
      enqueue: { jobType },
    });
  }

  /** Used by the CLI to register the repository this installation manages. */
  async ensureProject(input: {
    name: string;
    repoPath: string;
    kind?: ProjectKind;
  }): Promise<{ id: string; created: boolean }> {
    const repos = createRepositories(this.db);
    const existing = await repos.projects.findByRepoPath(input.repoPath);
    if (existing) return { id: existing.id, created: false };
    const git = new GitClient(input.repoPath);
    const defaultBranch = await git.defaultBranch();
    const remoteUrl = await git.remoteUrl();
    const project = await repos.projects.create({
      name: input.name,
      repoPath: input.repoPath,
      defaultBranch,
      remoteUrl,
      kind: input.kind ?? 'PROJECT',
    });
    const events = new EventLog(this.db);
    await events.append({
      projectId: project.id,
      eventType: 'ProjectCreated',
      actorType: 'system',
      actorId: 'cli',
      payload: { repoPath: input.repoPath, defaultBranch, hasRemote: Boolean(remoteUrl) },
    });
    return { id: project.id, created: true };
  }
}

export function newActorId(prefix: string): string {
  return `${prefix}-${newId().slice(0, 8)}`;
}
