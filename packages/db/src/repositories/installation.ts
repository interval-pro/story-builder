import { newId } from '@ai-engine/shared';
import type { InstallationApply } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const COLUMNS = `id, project_id, task_id, source, candidate_ref, previous_commit, status, step, log,
  built_commit, snapshot_path, started_at, finished_at`;

/**
 * Applying a candidate stops every service, so the process doing the work
 * cannot also report on it. Postgres stays up throughout, which makes this the
 * only place the cockpit can read the outcome from once it comes back.
 */
export class InstallationApplyRepository {
  constructor(private readonly db: Queryable) {}

  async start(input: {
    projectId: string;
    taskId?: string | null;
    source: 'TASK' | 'UPSTREAM' | 'LOCAL';
    candidateRef: string;
    previousCommit: string;
    /**
     * The commit the running build was made from, read from build.json rather
     * than from the checkout. It is the rollback target precisely because it is
     * the version that was serving when this started.
     */
    builtCommit?: string | null;
  }): Promise<InstallationApply> {
    const row = await this.db.queryOne(
      `INSERT INTO installation_applies (id, project_id, task_id, source, candidate_ref, previous_commit, built_commit)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
      [
        newId(),
        input.projectId,
        input.taskId ?? null,
        input.source,
        input.candidateRef,
        input.previousCommit,
        input.builtCommit ?? null,
      ],
    );
    return camelize<InstallationApply>(row!);
  }

  /** Where the pre-migration dump went, recorded the moment it exists. */
  async recordSnapshot(id: string, snapshotPath: string): Promise<void> {
    await this.db.query('UPDATE installation_applies SET snapshot_path = $2 WHERE id = $1', [id, snapshotPath]);
  }

  async findById(id: string): Promise<InstallationApply | null> {
    const row = await this.db.queryOne(`SELECT ${COLUMNS} FROM installation_applies WHERE id = $1`, [id]);
    return row ? camelize<InstallationApply>(row) : null;
  }

  async progress(id: string, step: string, appendLog: string): Promise<void> {
    await this.db.query(
      `UPDATE installation_applies SET step = $2, log = log || $3 WHERE id = $1`,
      [id, step, appendLog.endsWith('\n') ? appendLog : `${appendLog}\n`],
    );
  }

  async finish(id: string, status: 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK', appendLog = ''): Promise<void> {
    await this.db.query(
      `UPDATE installation_applies SET status = $2, log = log || $3, finished_at = now() WHERE id = $1`,
      [id, status, appendLog],
    );
  }

  async latest(projectId: string): Promise<InstallationApply | null> {
    const row = await this.db.queryOne(
      `SELECT ${COLUMNS} FROM installation_applies WHERE project_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [projectId],
    );
    return row ? camelize<InstallationApply>(row) : null;
  }

  async findRunning(): Promise<InstallationApply | null> {
    const row = await this.db.queryOne(
      `SELECT ${COLUMNS} FROM installation_applies WHERE status = 'RUNNING' ORDER BY started_at DESC LIMIT 1`,
    );
    return row ? camelize<InstallationApply>(row) : null;
  }

  async findByTask(taskId: string): Promise<InstallationApply[]> {
    return camelizeAll<InstallationApply>(
      await this.db.query(`SELECT ${COLUMNS} FROM installation_applies WHERE task_id = $1 ORDER BY started_at DESC`, [
        taskId,
      ]),
    );
  }
}
