import { newId } from '@ai-engine/shared';
import type { Metric, QaFinding, QaNote, QaRun, TestRun } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';
import { toJson } from '../sanitize';

const TEST_COLUMNS = 'id, task_id, run_id, command, exit_code, passed, duration_ms, log_artifact_id, created_at';

export class TestRunRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: {
    taskId: string;
    runId?: string | null;
    command: string;
    exitCode: number;
    durationMs: number;
    logArtifactId?: string | null;
  }): Promise<TestRun> {
    const row = await this.db.queryOne(
      `INSERT INTO test_runs (id, task_id, run_id, command, exit_code, passed, duration_ms, log_artifact_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${TEST_COLUMNS}`,
      [
        newId(),
        input.taskId,
        input.runId ?? null,
        input.command,
        input.exitCode,
        input.exitCode === 0,
        input.durationMs,
        input.logArtifactId ?? null,
      ],
    );
    return camelize<TestRun>(row!);
  }

  async listByTask(taskId: string): Promise<TestRun[]> {
    return camelizeAll<TestRun>(
      await this.db.query(`SELECT ${TEST_COLUMNS} FROM test_runs WHERE task_id = $1 ORDER BY created_at ASC`, [taskId]),
    );
  }

  async latest(taskId: string): Promise<TestRun | null> {
    const row = await this.db.queryOne(
      `SELECT ${TEST_COLUMNS} FROM test_runs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    return row ? camelize<TestRun>(row) : null;
  }
}

const QA_COLUMNS = 'id, task_id, run_id, iteration, verdict, findings, notes, created_at';

export class QaRunRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: {
    taskId: string;
    runId: string;
    iteration: number;
    verdict: QaRun['verdict'];
    findings: QaFinding[];
    /**
     * Remarks the run did not block on. They used to be described in the summary
     * prose and then never written anywhere, so the agent that could have acted
     * on them never saw them.
     */
    notes?: QaNote[];
  }): Promise<QaRun> {
    const row = await this.db.queryOne(
      `INSERT INTO qa_runs (id, task_id, run_id, iteration, verdict, findings, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${QA_COLUMNS}`,
      [
        newId(),
        input.taskId,
        input.runId,
        input.iteration,
        input.verdict,
        toJson(input.findings),
        toJson(input.notes ?? []),
      ],
    );
    return camelize<QaRun>(row!);
  }

  async listByTask(taskId: string): Promise<QaRun[]> {
    return camelizeAll<QaRun>(
      await this.db.query(`SELECT ${QA_COLUMNS} FROM qa_runs WHERE task_id = $1 ORDER BY iteration ASC`, [taskId]),
    );
  }

  async latest(taskId: string): Promise<QaRun | null> {
    const row = await this.db.queryOne(
      `SELECT ${QA_COLUMNS} FROM qa_runs WHERE task_id = $1 ORDER BY iteration DESC LIMIT 1`,
      [taskId],
    );
    return row ? camelize<QaRun>(row) : null;
  }
}

export class MetricRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: {
    projectId: string;
    taskId?: string | null;
    name: string;
    value: number;
    labels?: Record<string, string>;
  }): Promise<void> {
    await this.db.query(
      'INSERT INTO metrics (id, project_id, task_id, name, value, labels) VALUES ($1, $2, $3, $4, $5, $6)',
      [newId(), input.projectId, input.taskId ?? null, input.name, input.value, toJson(input.labels ?? {})],
    );
  }

  async summary(projectId: string): Promise<{ name: string; count: number; total: number }[]> {
    const rows = await this.db.query<{ name: string; count: string; total: string }>(
      `SELECT name, COUNT(*)::text AS count, COALESCE(SUM(value), 0)::text AS total
       FROM metrics WHERE project_id = $1 GROUP BY name ORDER BY name`,
      [projectId],
    );
    return rows.map((row) => ({ name: row.name, count: Number(row.count), total: Number(row.total) }));
  }

  async listByTask(taskId: string): Promise<Metric[]> {
    return camelizeAll<Metric>(
      await this.db.query(
        'SELECT id, project_id, task_id, name, value, labels, created_at FROM metrics WHERE task_id = $1 ORDER BY created_at ASC',
        [taskId],
      ),
    );
  }
}
