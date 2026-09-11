import path from 'node:path';
import { AppError, createLogger, loadConfig, newId, slugify } from '@ai-engine/shared';
import {
  classifyRisk,
  classifyTaskSize,
  requiresSecondApproval,
  type Project,
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
    if (project.setupState !== 'READY') {
      throw new AppError(
        'project_not_ready',
        project.setupState === 'FAILED'
          ? `${project.name} could not be prepared: ${project.setupError ?? 'no reason was recorded'}`
          : `${project.name} is still being prepared. A story needs its runtime manifest and first knowledge snapshot.`,
        409,
        { setupState: project.setupState },
      );
    }

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

    // A blocking decision is one where implementing without an answer would mean
    // guessing. Approving over it would hand that guess to the agent, which is
    // the whole thing the decision exists to prevent.
    const openBlocking = await repos.reviewDecisions.openBlockingCount(version.id);
    if (openBlocking > 0) {
      throw new AppError(
        'decisions_open',
        `${openBlocking} decision(s) on this plan have to be answered before it can be approved.`,
        409,
        { openBlocking },
      );
    }

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

    // Queued work for a story that is over can only fail, and while it waits it
    // sits in front of everything else in that project's directory. A job that is
    // already running is left alone: its worker owns it and will end it.
    const queue = new JobQueue(this.db);
    await queue.cancelPendingForTask(taskId);

    // The story may still hold the project directory, on its own branch. This
    // commits whatever is there and puts the directory back where its owner left
    // it, which is the only thing a stop still owes anyone.
    await queue.enqueue({
      taskId,
      projectId: task.projectId,
      jobType: 'RELEASE_DIRECTORY',
      payload: { taskId, projectId: task.projectId },
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

    // A retry before the review was approved used to start the research again,
    // which threw away whatever notes had been written on the review in the
    // meantime and produced a second first draft. If there are open notes, the
    // thing to continue is the regeneration they were written for.
    const review = approvedReviewVersionId ? null : await repos.reviews.findCurrentForTask(taskId);
    const openNotes = review ? await repos.reviews.listOpenNotes(review.id) : [];

    // A task that failed after the pull request was approved failed in
    // integration or in the push. Sending it back to QA would re-run an agent
    // over a diff that has already been checked and approved.
    const prApproval = await repos.approvals.findLatest(taskId, 'PR');
    const pushAttempted = (await repos.runs.listByTask(taskId)).some((run) => run.phase === 'PUSH');

    const target = !approvedReviewVersionId
      ? openNotes.length > 0
        ? { state: 'REVIEW_REGENERATING' as const, jobType: 'REVIEW_REGENERATE' as const }
        : { state: 'ANALYSIS_QUEUED' as const, jobType: 'RESEARCH' as const }
      : prApproval?.decision === 'APPROVED'
        ? pushAttempted
          ? { state: 'PUSHING' as const, jobType: 'PUSH_AND_PR' as const }
          : { state: 'INTEGRATION_VALIDATION' as const, jobType: 'INTEGRATION_VALIDATION' as const }
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

  /**
   * Unblocks a task by sending it back to the step the human chooses.
   *
   * PUSHING and INTEGRATION_VALIDATION are here because a push that fails blocks
   * the task, and every other route re-runs an agent over work that was already
   * finished. Without them the only reachable end was STOPPED, which meant
   * pushing the branch by hand and leaving the record wrong.
   */
  async unblock(input: { taskId: string; target: UnblockTarget; actor: Actor }): Promise<Task> {
    const jobType = UNBLOCK_JOBS[input.target];
    return this.orchestrator.transition({
      taskId: input.taskId,
      to: input.target,
      actor: input.actor,
      reason: 'unblocked by human',
      patch: { blockedReason: null },
      enqueue: { jobType },
    });
  }

  /**
   * Answers one decision on the current review version.
   *
   * 'custom' carries the person's own words; 'agent' hands the choice back with
   * the reasons stated, which is a decision in itself and is recorded as one
   * rather than left as an unanswered question.
   */
  async answerDecision(input: {
    taskId: string;
    key: string;
    chosenKey: string;
    customAnswer?: string | null;
    actor: Actor;
  }): Promise<{ answered: number; openBlocking: number }> {
    const repos = createRepositories(this.db);
    if (input.chosenKey === 'custom' && !input.customAnswer?.trim()) {
      throw new AppError('empty_answer', 'Describing the decision yourself needs some text', 400);
    }

    const decision = await repos.reviewDecisions.answerForTask({
      taskId: input.taskId,
      key: input.key,
      chosenKey: input.chosenKey,
      customAnswer: input.customAnswer?.trim() || null,
      answeredBy: input.actor.id,
    });
    await new EventLog(this.db).append({
      projectId: (await repos.tasks.getById(input.taskId)).projectId,
      taskId: input.taskId,
      eventType: 'HumanNoteAdded',
      actorType: input.actor.type,
      actorId: input.actor.id,
      payload: { decision: decision.key, chosen: decision.chosenKey, blocking: decision.blocking },
    });

    const open = await repos.reviewDecisions.listOpenForTask(input.taskId);
    return { answered: 1, openBlocking: open.filter((entry) => entry.blocking).length };
  }

  /**
   * Turns a story draft into a task and starts it.
   *
   * The draft is the thing a person edited and kept; this is the one moment it
   * stops being editable text and becomes work with a branch.
   */
  async launchDraft(input: { draftId: string; actor: Actor }): Promise<{ story: Story; task: Task }> {
    const repos = createRepositories(this.db);
    const draft = await repos.ideas.getDraft(input.draftId);
    if (draft.status !== 'DRAFT') {
      throw new AppError('draft_not_open', `This draft is already ${draft.status.toLowerCase()}`, 409);
    }
    const created = await this.createStory({
      projectId: draft.projectId,
      title: draft.title,
      body: draft.body,
      actor: input.actor,
      startAnalysis: true,
    });
    await repos.ideas.markDraftLaunched(draft.id, created.task.id);
    return { story: created.story, task: created.task };
  }

  /**
   * Registers a repository as a project and queues everything it needs.
   *
   * Detecting how a project builds and walking it for the first knowledge
   * snapshot both mean reading the whole tree, which is not something to do
   * inside a request. The row exists immediately so the cockpit can show it;
   * the setup job moves it from PENDING to READY.
   */
  async registerProject(input: { repoPath: string; name?: string; description?: string | null }): Promise<Project> {
    const repos = createRepositories(this.db);
    const resolved = path.resolve(input.repoPath);

    const installRoot = path.resolve(loadConfig().paths.installRoot);
    if (resolved === installRoot) {
      throw new AppError(
        'project_is_installation',
        'That directory is the installation itself. It is already registered, and a project has to be a repository the engine works on.',
        400,
      );
    }

    const existing = await repos.projects.findByRepoPath(resolved);
    if (existing) throw new AppError('project_exists', `${resolved} is already registered as "${existing.name}"`, 409);

    const git = new GitClient(resolved);
    if (!(await git.isRepository())) {
      throw new AppError('not_a_repository', `${resolved} is not a Git repository`, 400);
    }
    if (!(await git.hasCommits())) {
      throw new AppError(
        'no_commits',
        `${resolved} has no commits yet. Every task starts from a base commit, so make the first one.`,
        400,
      );
    }

    // The branch it is on right now, not the repository's nominal default. A
    // person who added a project while sitting on a release branch meant that
    // branch, and they can change it afterwards.
    const current = await git.currentBranch().catch(() => '');
    const project = await repos.projects.create({
      name: input.name?.trim() || path.basename(resolved),
      repoPath: resolved,
      defaultBranch: await git.defaultBranch(),
      remoteUrl: await git.remoteUrl(),
      description: input.description ?? null,
      setupState: 'PENDING',
      ...(current && current !== 'HEAD' ? { workBranch: current } : {}),
    });

    await new JobQueue(this.db).enqueue({
      taskId: null,
      projectId: project.id,
      jobType: 'PROJECT_SETUP',
      payload: { projectId: project.id },
    });
    return project;
  }

  /** Starts a round of turning an idea into stories. */
  async startIdea(input: { projectId: string; idea: string }): Promise<{ sessionId: string }> {
    const repos = createRepositories(this.db);
    const session = await repos.ideas.create({ projectId: input.projectId, idea: input.idea });
    await new JobQueue(this.db).enqueue({
      taskId: null,
      projectId: input.projectId,
      jobType: 'IDEA_INTAKE',
      payload: { projectId: input.projectId, sessionId: session.id },
    });
    return { sessionId: session.id };
  }

  /**
   * Records an answer and, once the round is fully answered, asks the next one.
   *
   * The round is the unit: asking again before every question in it is answered
   * would spend a run on a half-answered round, and answering out of order is
   * something a person does routinely.
   */
  async answerIdeaQuestion(input: {
    sessionId: string;
    questionId: string;
    chosenKey: string;
    customAnswer?: string | null;
  }): Promise<{ remaining: number }> {
    const repos = createRepositories(this.db);
    const session = await repos.ideas.getById(input.sessionId);
    if (input.chosenKey === 'custom' && !input.customAnswer?.trim()) {
      throw new AppError('empty_answer', 'Writing your own answer needs some text', 400);
    }
    await repos.ideas.answerQuestion(input.questionId, {
      chosenKey: input.chosenKey,
      customAnswer: input.customAnswer?.trim() || null,
    });

    const remaining = await repos.ideas.unansweredCount(input.sessionId);
    if (remaining === 0) {
      await repos.ideas.update(input.sessionId, { status: 'QUEUED' });
      await new JobQueue(this.db).enqueue({
        taskId: null,
        projectId: session.projectId,
        jobType: 'IDEA_INTAKE',
        payload: { projectId: session.projectId, sessionId: session.id },
      });
    }
    return { remaining };
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

/** Where a blocked task may be sent back to, and what runs when it gets there. */
const UNBLOCK_JOBS = {
  ANALYSIS_QUEUED: 'RESEARCH',
  IMPLEMENTATION_QUEUED: 'IMPLEMENTATION',
  FIX_REQUIRED: 'FIX',
  INTEGRATION_VALIDATION: 'INTEGRATION_VALIDATION',
  PUSHING: 'PUSH_AND_PR',
} as const;

export type UnblockTarget = keyof typeof UNBLOCK_JOBS;

export const UNBLOCK_TARGETS = Object.keys(UNBLOCK_JOBS) as UnblockTarget[];

export function newActorId(prefix: string): string {
  return `${prefix}-${newId().slice(0, 8)}`;
}
