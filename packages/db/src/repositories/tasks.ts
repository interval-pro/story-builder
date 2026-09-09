import { newId, NotFoundError } from '@ai-engine/shared';
import type { RiskLevel, Task, TaskState } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const COLUMNS = `id, project_id, story_id, story_revision_id, state, previous_state, kind, branch_name,
  base_branch, base_commit, knowledge_snapshot_id, risk_level, qa_iteration, base_moved,
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
    kind?: 'PROJECT_TASK' | 'SYSTEM_TASK';
    knowledgeSnapshotId?: string | null;
  }): Promise<Task> {
    const row = await this.db.queryOne(
      `INSERT INTO tasks (id, project_id, story_id, story_revision_id, branch_name, base_branch, base_commit, kind, knowledge_snapshot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
      [
        newId(),
        input.projectId,
        input.storyId,
        input.storyRevisionId,
        input.branchName,
        input.baseBranch,
        input.baseCommit,
        input.kind ?? 'PROJECT_TASK',
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
