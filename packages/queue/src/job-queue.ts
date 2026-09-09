import { backoffMs, newId, NotFoundError } from '@ai-engine/shared';
import type { Job, JobType } from '@ai-engine/domain';
import { camelize, camelizeAll, type Queryable } from '@ai-engine/db';

const COLUMNS = `id, task_id, job_type, payload, status, attempt, max_attempts, available_at, locked_by,
  locked_at, last_error, created_at, completed_at`;

export interface EnqueueInput {
  taskId: string | null;
  jobType: JobType;
  payload?: Record<string, unknown>;
  availableAt?: Date;
  maxAttempts?: number;
}

/**
 * Durable queue backed by Postgres. Workers claim with FOR UPDATE SKIP LOCKED,
 * which means a crashed worker never permanently loses a job.
 */
export class JobQueue {
  constructor(private readonly db: Queryable) {}

  /**
   * A task may queue its next job while its current one is still running, but
   * never two pending jobs of the same type. The partial unique index enforces
   * that, and ON CONFLICT turns a race into a no-op instead of an error.
   */
  async enqueue(input: EnqueueInput): Promise<Job | null> {
    const rows = await this.db.query(
      `INSERT INTO jobs (id, task_id, job_type, payload, available_at, max_attempts)
       VALUES ($1, $2, $3, $4, COALESCE($5, now()), COALESCE($6, 3))
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        newId(),
        input.taskId,
        input.jobType,
        JSON.stringify(input.payload ?? {}),
        input.availableAt ?? null,
        input.maxAttempts ?? null,
      ],
    );
    const row = rows[0];
    return row ? camelize<Job>(row) : null;
  }

  /** Claims the oldest available job, skipping rows other workers hold. */
  async claim(workerId: string, jobTypes?: JobType[]): Promise<Job | null> {
    const typeFilter = jobTypes && jobTypes.length > 0 ? 'AND job_type = ANY($2::text[])' : '';
    const params: unknown[] = [workerId];
    if (typeFilter) params.push(jobTypes);
    const rows = await this.db.query(
      `UPDATE jobs SET
         status = 'RUNNING',
         attempt = attempt + 1,
         locked_by = $1,
         locked_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'PENDING' AND available_at <= now() ${typeFilter}
         ORDER BY available_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${COLUMNS}`,
      params,
    );
    const row = rows[0];
    return row ? camelize<Job>(row) : null;
  }

  async complete(jobId: string): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'COMPLETED', completed_at = now(), locked_by = NULL, locked_at = NULL WHERE id = $1`,
      [jobId],
    );
  }

  /**
   * Reschedules with exponential backoff until max_attempts is reached, after
   * which the job is marked FAILED and the orchestrator takes over.
   */
  async fail(jobId: string, error: string): Promise<{ retrying: boolean; job: Job }> {
    const job = await this.getById(jobId);
    const retrying = job.attempt < job.maxAttempts;
    const rows = await this.db.query(
      retrying
        ? `UPDATE jobs SET status = 'PENDING', last_error = $2, locked_by = NULL, locked_at = NULL,
             available_at = now() + ($3 || ' milliseconds')::interval
           WHERE id = $1 RETURNING ${COLUMNS}`
        : `UPDATE jobs SET status = 'FAILED', last_error = $2, locked_by = NULL, locked_at = NULL, completed_at = now()
           WHERE id = $1 RETURNING ${COLUMNS}`,
      retrying ? [jobId, error.slice(0, 4000), String(backoffMs(job.attempt))] : [jobId, error.slice(0, 4000)],
    );
    return { retrying, job: camelize<Job>(rows[0]!) };
  }

  async getById(id: string): Promise<Job> {
    const row = await this.db.queryOne(`SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [id]);
    if (!row) throw new NotFoundError('Job', id);
    return camelize<Job>(row);
  }

  async findActiveForTask(taskId: string): Promise<Job | null> {
    const row = await this.db.queryOne(
      `SELECT ${COLUMNS} FROM jobs WHERE task_id = $1 AND status IN ('PENDING', 'RUNNING') LIMIT 1`,
      [taskId],
    );
    return row ? camelize<Job>(row) : null;
  }

  async listByTask(taskId: string, limit = 50): Promise<Job[]> {
    return camelizeAll<Job>(
      await this.db.query(`SELECT ${COLUMNS} FROM jobs WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2`, [taskId, limit]),
    );
  }

  /**
   * Cancels queued work. A RUNNING job is left alone: its worker owns it and
   * will finish or fail it, and killing the row would strand the lease.
   */
  async cancelPendingForTask(taskId: string): Promise<number> {
    const rows = await this.db.query(
      `UPDATE jobs SET status = 'CANCELLED', completed_at = now() WHERE task_id = $1 AND status = 'PENDING' RETURNING id`,
      [taskId],
    );
    return rows.length;
  }

  /**
   * Returns jobs whose lease expired because their worker died, so they can be
   * picked up again. This is the core of crash resumability.
   */
  async reclaimExpired(leaseSeconds: number): Promise<Job[]> {
    const rows = await this.db.query(
      `UPDATE jobs SET status = 'PENDING', locked_by = NULL, locked_at = NULL, available_at = now()
       WHERE status = 'RUNNING' AND locked_at < now() - ($1 || ' seconds')::interval
       RETURNING ${COLUMNS}`,
      [String(leaseSeconds)],
    );
    return camelizeAll<Job>(rows);
  }

  async stats(): Promise<Record<string, number>> {
    const rows = await this.db.query<{ status: string; count: string }>(
      'SELECT status, COUNT(*)::text AS count FROM jobs GROUP BY status',
    );
    const stats: Record<string, number> = {};
    for (const row of rows) stats[row.status] = Number(row.count);
    return stats;
  }
}
