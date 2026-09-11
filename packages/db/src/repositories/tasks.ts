import { newId, NotFoundError } from '@ai-engine/shared';
import { HUMAN_GATE_STATES, type RiskLevel, type Task, type TaskState } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const COLUMNS = `id, project_id, story_id, story_revision_id, state, previous_state, branch_name,
  base_branch, base_commit, knowledge_snapshot_id, risk_level, size, qa_iteration, base_moved,
  blocked_reason, failure_reason, created_at, updated_at`;

export class TaskRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    projectId: string;
    storyId: string;
    storyRevisionId: string;
    branchName: string;
    baseBranch: string;
    baseCommit: string;
    knowledgeSnapshotId?: string | null;
  }): Promise<Task> {
    const row = await this.db.queryOne(
      `INSERT INTO tasks (id, project_id, story_id, story_revision_id, branch_name, base_branch, base_commit, knowledge_snapshot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
      [
        newId(),
        input.projectId,
        input.storyId,
        input.storyRevisionId,
        input.branchName,
        input.baseBranch,
        input.baseCommit,
        input.knowledgeSnapshotId ?? null,
      ],
    );
    return camelize<Task>(row!);
  }

  async findById(id: string): Promise<Task | null> {
    const row = await this.db.queryOne(`SELECT ${COLUMNS} FROM tasks WHERE id = $1`, [id]);
    return row ? camelize<Task>(row) : null;
  }

  async getById(id: string): Promise<Task> {
    const task = await this.findById(id);
    if (!task) throw new NotFoundError('Task', id);
    return task;
  }

  /** Locks the row so the orchestrator never races with itself on a transition. */
  async getByIdForUpdate(id: string): Promise<Task> {
    const row = await this.db.queryOne(`SELECT ${COLUMNS} FROM tasks WHERE id = $1 FOR UPDATE`, [id]);
    if (!row) throw new NotFoundError('Task', id);
    return camelize<Task>(row);
  }

  async findByStory(storyId: string): Promise<Task[]> {
    return camelizeAll<Task>(
      await this.db.query(`SELECT ${COLUMNS} FROM tasks WHERE story_id = $1 ORDER BY created_at DESC`, [storyId]),
    );
  }

  async listByProject(projectId: string, limit = 100): Promise<Task[]> {
    return camelizeAll<Task>(
      await this.db.query(`SELECT ${COLUMNS} FROM tasks WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`, [
        projectId,
        limit,
      ]),
    );
  }

  async listActive(projectId: string): Promise<Task[]> {
    return camelizeAll<Task>(
      await this.db.query(
        `SELECT ${COLUMNS} FROM tasks
         WHERE project_id = $1 AND state NOT IN ('COMPLETED', 'STOPPED', 'ROLLED_BACK', 'DRAFT')
         ORDER BY created_at ASC`,
        [projectId],
      ),
    );
  }

  /**
   * Tasks that are genuinely in flight anywhere: a job of theirs is pending or
   * running.
   *
   * This is what "still running" has to mean. The older reading — anything not
   * in a terminal state — counted a review waiting for approval and a task that
   * had been blocked for a day, which is how an engine update came to be refused
   * with the words "tasks are still running" while nothing was running at all.
   */
  async listWithActiveJobs(): Promise<(Task & { projectName: string; storyTitle: string })[]> {
    return camelizeAll<Task & { projectName: string; storyTitle: string }>(
      await this.db.query(
        `SELECT ${COLUMNS.split(',').map((column) => `t.${column.trim()}`).join(', ')},
                p.name AS project_name, s.title AS story_title
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN stories s ON s.id = t.story_id
          WHERE EXISTS (
            SELECT 1 FROM jobs j WHERE j.task_id = t.id AND j.status IN ('PENDING', 'RUNNING')
          )
          ORDER BY t.created_at ASC`,
      ),
    );
  }

  /**
   * Tasks that cannot move until a person acts, across every project.
   *
   * The cockpit shows these separately from the queue, because they are not
   * waiting for a machine and no amount of concurrency will clear them.
   */
  async listWaitingForHuman(): Promise<(Task & { projectName: string; storyTitle: string })[]> {
    return camelizeAll<Task & { projectName: string; storyTitle: string }>(
      await this.db.query(
        `SELECT ${COLUMNS.split(',').map((column) => `t.${column.trim()}`).join(', ')},
                p.name AS project_name, s.title AS story_title
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN stories s ON s.id = t.story_id
          WHERE t.state = ANY($1::text[])
          ORDER BY t.updated_at ASC`,
        [[...HUMAN_GATE_STATES]],
      ),
    );
  }

  /** Tasks with an agent actually working on them, for the overview. */
  async listRunning(): Promise<(Task & { projectName: string; storyTitle: string })[]> {
    return camelizeAll<Task & { projectName: string; storyTitle: string }>(
      await this.db.query(
        `SELECT ${COLUMNS.split(',').map((column) => `t.${column.trim()}`).join(', ')},
                p.name AS project_name, s.title AS story_title
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN stories s ON s.id = t.story_id
          WHERE t.state NOT IN ('COMPLETED', 'STOPPED', 'ROLLED_BACK', 'DRAFT', 'PAUSED', 'FAILED')
            AND t.state <> ALL($1::text[])
          ORDER BY t.updated_at DESC`,
        [[...HUMAN_GATE_STATES]],
      ),
    );
  }

  /** A project's tasks with the story title, which is what a list ever shows. */
  async listByProjectWithStory(
    projectId: string,
    limit = 100,
  ): Promise<(Task & { projectName: string; storyTitle: string })[]> {
    return camelizeAll<Task & { projectName: string; storyTitle: string }>(
      await this.db.query(
        `SELECT ${COLUMNS.split(',').map((column) => `t.${column.trim()}`).join(', ')},
                p.name AS project_name, s.title AS story_title
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN stories s ON s.id = t.story_id
          WHERE t.project_id = $1
          ORDER BY t.created_at DESC
          LIMIT $2`,
        [projectId, limit],
      ),
    );
  }

  /** Counts per state for one project, for the overview tiles. */
  async countsByState(projectId: string): Promise<Record<string, number>> {
    const rows = await this.db.query<{ state: string; count: string }>(
      'SELECT state, COUNT(*)::text AS count FROM tasks WHERE project_id = $1 GROUP BY state',
      [projectId],
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.state] = Number(row.count);
    return counts;
  }

  async listByState(state: TaskState): Promise<Task[]> {
    return camelizeAll<Task>(await this.db.query(`SELECT ${COLUMNS} FROM tasks WHERE state = $1`, [state]));
  }

  /**
   * Writes the new state. The caller is responsible for validating the
   * transition through the domain state machine first.
   */
  async setState(id: string, from: TaskState, to: TaskState): Promise<Task> {
    const row = await this.db.queryOne(
      `UPDATE tasks SET state = $3, previous_state = $2, updated_at = now()
       WHERE id = $1 AND state = $2 RETURNING ${COLUMNS}`,
      [id, from, to],
    );
    if (!row) throw new NotFoundError(`Task in state ${from}`, id);
    return camelize<Task>(row);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Task,
        | 'riskLevel'
        | 'size'
        | 'qaIteration'
        | 'baseMoved'
        | 'blockedReason'
        | 'failureReason'
        | 'baseCommit'
        | 'knowledgeSnapshotId'
        | 'storyRevisionId'
      >
    >,
  ): Promise<Task> {
    // size goes through COALESCE, not the unconditional style blocked_reason and
    // failure_reason use: those are meant to be cleared by a patch that omits
    // them, and a size that vanished on the next unrelated update would send
    // every later phase back to classifying the change again.
    const row = await this.db.queryOne(
      `UPDATE tasks SET
         risk_level = COALESCE($2, risk_level),
         qa_iteration = COALESCE($3, qa_iteration),
         base_moved = COALESCE($4, base_moved),
         blocked_reason = $5,
         failure_reason = $6,
         base_commit = COALESCE($7, base_commit),
         knowledge_snapshot_id = COALESCE($8, knowledge_snapshot_id),
         story_revision_id = COALESCE($9, story_revision_id),
         size = COALESCE($10, size),
         updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [
        id,
        (patch.riskLevel ?? null) as RiskLevel | null,
        patch.qaIteration ?? null,
        patch.baseMoved ?? null,
        patch.blockedReason ?? null,
        patch.failureReason ?? null,
        patch.baseCommit ?? null,
        patch.knowledgeSnapshotId ?? null,
        patch.storyRevisionId ?? null,
        patch.size ?? null,
      ],
    );
    if (!row) throw new NotFoundError('Task', id);
    return camelize<Task>(row);
  }

  async incrementQaIteration(id: string): Promise<number> {
    const row = await this.db.queryOne<{ qa_iteration: number }>(
      'UPDATE tasks SET qa_iteration = qa_iteration + 1, updated_at = now() WHERE id = $1 RETURNING qa_iteration',
      [id],
    );
    if (!row) throw new NotFoundError('Task', id);
    return row.qa_iteration;
  }
}
