import { newId, NotFoundError } from '@ai-engine/shared';
import type { ExecutionPhase, TaskCheckpoint, TaskRun, ToolCall } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const RUN_COLUMNS = `id, task_id, phase, agent_type, agent_version_id, status, started_at, finished_at,
  input_tokens, output_tokens, error_message`;

export class TaskRunRepository {
  constructor(private readonly db: Queryable) {}

  async start(input: {
    taskId: string;
    phase: ExecutionPhase;
    agentType: string;
    agentVersionId?: string | null;
  }): Promise<TaskRun> {
    const row = await this.db.queryOne(
      `INSERT INTO task_runs (id, task_id, phase, agent_type, agent_version_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${RUN_COLUMNS}`,
      [newId(), input.taskId, input.phase, input.agentType, input.agentVersionId ?? null],
    );
    return camelize<TaskRun>(row!);
  }

  async complete(id: string, usage?: { inputTokens?: number; outputTokens?: number }): Promise<TaskRun> {
    const row = await this.db.queryOne(
      `UPDATE task_runs SET status = 'COMPLETED', finished_at = now(),
         input_tokens = COALESCE($2, input_tokens), output_tokens = COALESCE($3, output_tokens)
       WHERE id = $1 RETURNING ${RUN_COLUMNS}`,
      [id, usage?.inputTokens ?? null, usage?.outputTokens ?? null],
    );
    if (!row) throw new NotFoundError('TaskRun', id);
    return camelize<TaskRun>(row);
  }

  async fail(id: string, errorMessage: string): Promise<TaskRun> {
    const row = await this.db.queryOne(
      `UPDATE task_runs SET status = 'FAILED', finished_at = now(), error_message = $2
       WHERE id = $1 RETURNING ${RUN_COLUMNS}`,
      [id, errorMessage.slice(0, 4000)],
    );
    if (!row) throw new NotFoundError('TaskRun', id);
    return camelize<TaskRun>(row);
  }

  async listByTask(taskId: string): Promise<TaskRun[]> {
    return camelizeAll<TaskRun>(
      await this.db.query(`SELECT ${RUN_COLUMNS} FROM task_runs WHERE task_id = $1 ORDER BY started_at ASC`, [taskId]),
    );
  }

  async latestForPhase(taskId: string, phase: ExecutionPhase): Promise<TaskRun | null> {
    const row = await this.db.queryOne(
      `SELECT ${RUN_COLUMNS} FROM task_runs WHERE task_id = $1 AND phase = $2 ORDER BY started_at DESC LIMIT 1`,
      [taskId, phase],
    );
    return row ? camelize<TaskRun>(row) : null;
  }

  /** Marks runs that were interrupted by a crash so the UI never shows them as live. */
  async failStaleRuns(olderThanMinutes: number): Promise<number> {
    const rows = await this.db.query(
      `UPDATE task_runs SET status = 'FAILED', finished_at = now(), error_message = 'Run was interrupted'
       WHERE status = 'RUNNING' AND started_at < now() - ($1 || ' minutes')::interval RETURNING id`,
      [String(olderThanMinutes)],
    );
    return rows.length;
  }
}

const TOOL_CALL_COLUMNS = `id, task_id, run_id, sequence, tool_name, input, output_summary,
  output_artifact_id, status, duration_ms, created_at`;

export class ToolCallRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: {
    taskId: string;
    runId: string;
    sequence: number;
    toolName: string;
    input: Record<string, unknown>;
    outputSummary: string;
    outputArtifactId?: string | null;
    status: 'OK' | 'ERROR' | 'DENIED';
    durationMs: number;
  }): Promise<ToolCall> {
    const row = await this.db.queryOne(
      `INSERT INTO tool_calls (id, task_id, run_id, sequence, tool_name, input, output_summary, output_artifact_id, status, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${TOOL_CALL_COLUMNS}`,
      [
        newId(),
        input.taskId,
        input.runId,
        input.sequence,
        input.toolName,
        JSON.stringify(input.input),
        input.outputSummary.slice(0, 8000),
        input.outputArtifactId ?? null,
        input.status,
        input.durationMs,
      ],
    );
    return camelize<ToolCall>(row!);
  }

  async listByRun(runId: string): Promise<ToolCall[]> {
    return camelizeAll<ToolCall>(
      await this.db.query(`SELECT ${TOOL_CALL_COLUMNS} FROM tool_calls WHERE run_id = $1 ORDER BY sequence ASC`, [runId]),
    );
  }

  async listRecentByTask(taskId: string, limit = 50): Promise<ToolCall[]> {
    return camelizeAll<ToolCall>(
      await this.db.query(
        `SELECT ${TOOL_CALL_COLUMNS} FROM tool_calls WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [taskId, limit],
      ),
    );
  }
}

const CHECKPOINT_COLUMNS = `id, task_id, run_id, state, git_head, diff_artifact_id, workspace_metadata,
  migration_state, running_services, agent_versions, knowledge_snapshot_id, plan_position, created_at`;

export class CheckpointRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    taskId: string;
    runId?: string | null;
    state: string;
    gitHead?: string | null;
    diffArtifactId?: string | null;
    workspaceMetadata?: Record<string, unknown>;
    migrationState?: Record<string, unknown>;
    runningServices?: string[];
    agentVersions?: Record<string, string>;
    knowledgeSnapshotId?: string | null;
    planPosition?: number;
  }): Promise<TaskCheckpoint> {
    const row = await this.db.queryOne(
      `INSERT INTO task_checkpoints (id, task_id, run_id, state, git_head, diff_artifact_id, workspace_metadata,
         migration_state, running_services, agent_versions, knowledge_snapshot_id, plan_position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${CHECKPOINT_COLUMNS}`,
      [
        newId(),
        input.taskId,
        input.runId ?? null,
        input.state,
        input.gitHead ?? null,
        input.diffArtifactId ?? null,
        JSON.stringify(input.workspaceMetadata ?? {}),
        JSON.stringify(input.migrationState ?? {}),
        JSON.stringify(input.runningServices ?? []),
        JSON.stringify(input.agentVersions ?? {}),
        input.knowledgeSnapshotId ?? null,
        input.planPosition ?? 0,
      ],
    );
    return camelize<TaskCheckpoint>(row!);
  }

  async latest(taskId: string): Promise<TaskCheckpoint | null> {
    const row = await this.db.queryOne(
      `SELECT ${CHECKPOINT_COLUMNS} FROM task_checkpoints WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    return row ? camelize<TaskCheckpoint>(row) : null;
  }

  async listByTask(taskId: string): Promise<TaskCheckpoint[]> {
    return camelizeAll<TaskCheckpoint>(
      await this.db.query(`SELECT ${CHECKPOINT_COLUMNS} FROM task_checkpoints WHERE task_id = $1 ORDER BY created_at ASC`, [
        taskId,
      ]),
    );
  }
}
