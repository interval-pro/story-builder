import { backoffMs, newId, NotFoundError } from '@ai-engine/shared';
import { consumesAgentSlot, type Job, type JobType, type QueueEntry } from '@ai-engine/domain';
import { camelize, camelizeAll, type Queryable } from '@ai-engine/db';

const COLUMNS = `id, task_id, project_id, job_type, payload, status, attempt, max_attempts, available_at,
  locked_by, locked_at, last_error, created_at, completed_at, position, consumes_slot, held_at`;

/**
 * The advisory lock every claim takes.
 *
 * The admission rule counts how many slot-consuming jobs are running and then
 * claims one more. Two claims evaluating that count against the same snapshot
 * would both see room and both start, which with a limit of one means two agent
 * sessions where the owner asked for one. Serialising claims is the only way to
 * make the count mean what it says, and it costs nothing: a claim happens about
 * once a second per worker loop.
 */
const CLAIM_LOCK_KEY = 8_417_301;

export interface EnqueueInput {
  taskId: string | null;
  /** Set for work that belongs to a project rather than to one of its tasks. */
  projectId?: string | null;
  jobType: JobType;
  payload?: Record<string, unknown>;
  availableAt?: Date;
  maxAttempts?: number;
}

export interface ClaimOptions {
  jobTypes?: JobType[];
  /**
   * How many slot-consuming jobs may run at once, across every project. Read
   * from the settings by the caller, because the queue does not get to decide
   * policy and the number has to be current on every poll.
   */
  concurrency: number;
  /** While paused, nothing new starts. Running work is left to finish. */
  paused?: boolean;
}

/** A Queryable that can also open a transaction. Claiming needs one. */
export interface TransactionalQueryable extends Queryable {
  transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T>;
}

function hasTransaction(db: Queryable): db is TransactionalQueryable {
  return typeof (db as TransactionalQueryable).transaction === 'function';
}

/**
 * Durable queue backed by Postgres. Workers claim with FOR UPDATE SKIP LOCKED,
 * which means a crashed worker never permanently loses a job.
 *
 * There is one queue for every project. Ordering is by hand: `position` comes
 * from a sequence so insertion order is the natural order, and reordering only
 * rewrites those numbers.
 */
export class JobQueue {
  constructor(private readonly db: Queryable) {}

  /**
   * A task may queue its next job while its current one is still running, but
   * never two pending jobs of the same type. The partial unique indexes enforce
   * that for task work and for project work, and ON CONFLICT turns a race into a
   * no-op instead of an error.
   */
  async enqueue(input: EnqueueInput): Promise<Job | null> {
    const rows = await this.db.query(
      `INSERT INTO jobs (id, task_id, project_id, job_type, payload, available_at, max_attempts, consumes_slot)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), COALESCE($7, 3), $8)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        newId(),
        input.taskId,
        input.projectId ?? null,
        input.jobType,
        JSON.stringify(input.payload ?? {}),
        input.availableAt ?? null,
        input.maxAttempts ?? null,
        consumesAgentSlot(input.jobType),
      ],
    );
    const row = rows[0];
    return row ? camelize<Job>(row) : null;
  }

  /**
   * Claims the oldest available job the limit allows, skipping rows other
   * workers hold.
   *
   * When every slot is taken, work that does not consume one is still claimable.
   * That is the whole reason the flag exists: a chat turn is a person waiting at
   * a keyboard, and queueing it behind a fix cycle would make the chat useless
   * exactly when the system is busy.
   */
  async claim(workerId: string, options: ClaimOptions): Promise<Job | null> {
    if (options.paused) return null;
    if (!hasTransaction(this.db)) {
      throw new Error('Claiming a job needs a transaction, so the queue must be built on the database');
    }

    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [CLAIM_LOCK_KEY]);

      const running = await tx.queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM jobs WHERE status = 'RUNNING' AND consumes_slot`,
      );
      const slotsFree = Number(running?.count ?? 0) < Math.max(1, options.concurrency);

      const params: unknown[] = [workerId, slotsFree];
      const typeFilter = options.jobTypes && options.jobTypes.length > 0 ? `AND job_type = ANY($3::text[])` : '';
      if (typeFilter) params.push(options.jobTypes);

      const rows = await tx.query(
        `UPDATE jobs SET
           status = 'RUNNING',
           attempt = attempt + 1,
           locked_by = $1,
           locked_at = now()
         WHERE id = (
           SELECT id FROM jobs
           WHERE status = 'PENDING'
             AND available_at <= now()
             AND held_at IS NULL
             AND (NOT consumes_slot OR $2)
             ${typeFilter}
           ORDER BY position ASC, created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING ${COLUMNS}`,
        params,
      );
      const row = rows[0];
      return row ? camelize<Job>(row) : null;
    });
  }

  /**
   * Renews the lease of a job that is still being worked on. Agent runs take
   * far longer than a lease, so without this the orchestrator reclaims work
   * that never stopped and a second worker starts it again from the top.
   * Returns false when the job is no longer ours, which means we must stop.
   */
  async heartbeat(jobId: string, workerId: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE jobs SET locked_at = now()
       WHERE id = $1 AND locked_by = $2 AND status = 'RUNNING' RETURNING id`,
      [jobId, workerId],
    );
    return rows.length > 0;
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

  async findPendingForProject(projectId: string, jobType: JobType): Promise<Job | null> {
    const row = await this.db.queryOne(
      `SELECT ${COLUMNS} FROM jobs WHERE project_id = $1 AND job_type = $2 AND status IN ('PENDING', 'RUNNING') LIMIT 1`,
      [projectId, jobType],
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

  async cancel(jobId: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE jobs SET status = 'CANCELLED', completed_at = now() WHERE id = $1 AND status = 'PENDING' RETURNING id`,
      [jobId],
    );
    return rows.length > 0;
  }

  /** Parks one entry without pausing the queue, and lets it go again. */
  async hold(jobId: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE jobs SET held_at = now() WHERE id = $1 AND status = 'PENDING' AND held_at IS NULL RETURNING id`,
      [jobId],
    );
    return rows.length > 0;
  }

  async release(jobId: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE jobs SET held_at = NULL WHERE id = $1 AND held_at IS NOT NULL RETURNING id`,
      [jobId],
    );
    return rows.length > 0;
  }

  /**
   * Rewrites the order of the pending queue.
   *
   * Expects the complete ordered list of pending ids, which is what the cockpit
   * has after a drag. Positions are reassigned consecutively from the smallest
   * one already in the set, so the reordered block keeps its place relative to
   * anything that arrived since the list was read.
   */
  async reorder(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const base = await this.db.queryOne<{ base: string | null }>(
      `SELECT MIN(position)::text AS base FROM jobs WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const start = Number(base?.base ?? 0);
    const values = ids.map((id, index) => `($${index + 1}::uuid, ${start + index})`).join(', ');
    const rows = await this.db.query(
      `UPDATE jobs SET position = v.position
         FROM (VALUES ${values}) AS v(id, position)
        WHERE jobs.id = v.id AND jobs.status = 'PENDING'
        RETURNING jobs.id`,
      ids,
    );
    return rows.length;
  }

  /**
   * Everything in the queue, with the project and story it belongs to.
   *
   * The join is here rather than in the cockpit because a queue entry without a
   * project name is unreadable: the whole point of one shared queue is seeing
   * whose work is waiting behind whose.
   */
  async overview(limit = 200): Promise<QueueEntry[]> {
    const rows = await this.db.query(
      `SELECT j.id, j.job_type, j.status, j.position::text AS position, j.consumes_slot, j.held_at,
              j.attempt, j.max_attempts, j.available_at, j.created_at, j.locked_by, j.locked_at, j.last_error,
              j.task_id, t.state AS task_state,
              COALESCE(j.project_id, t.project_id) AS project_id,
              p.name AS project_name,
              s.title AS story_title
         FROM jobs j
         LEFT JOIN tasks t ON t.id = j.task_id
         LEFT JOIN stories s ON s.id = t.story_id
         LEFT JOIN projects p ON p.id = COALESCE(j.project_id, t.project_id)
        WHERE j.status IN ('PENDING', 'RUNNING')
        ORDER BY (j.status = 'RUNNING') DESC, j.position ASC, j.created_at ASC
        LIMIT $1`,
      [limit],
    );
    return camelizeAll<QueueEntry>(rows);
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

  /** How many slots are in use right now, for the queue header. */
  async runningSlots(): Promise<number> {
    const row = await this.db.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM jobs WHERE status = 'RUNNING' AND consumes_slot`,
    );
    return Number(row?.count ?? 0);
  }
}
