import { newId } from '@ai-engine/shared';
import type { ActorType, EventType, SystemEvent } from '@ai-engine/domain';
import { camelize, camelizeAll, type Queryable } from '@ai-engine/db';

const COLUMNS = 'event_id, project_id, task_id, run_id, event_type, actor_type, actor_id, payload, sequence, created_at';

export interface AppendEventInput {
  projectId: string;
  taskId?: string | null;
  runId?: string | null;
  eventType: EventType;
  actorType: ActorType;
  actorId: string;
  payload?: Record<string, unknown>;
}

/**
 * Append-only log of everything that happened. Rows are protected against
 * UPDATE and DELETE at the database level, so this class only ever inserts.
 */
export class EventLog {
  constructor(private readonly db: Queryable) {}

  async append(input: AppendEventInput): Promise<SystemEvent> {
    const row = await this.db.queryOne(
      `INSERT INTO events (event_id, project_id, task_id, run_id, event_type, actor_type, actor_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
      [
        newId(),
        input.projectId,
        input.taskId ?? null,
        input.runId ?? null,
        input.eventType,
        input.actorType,
        input.actorId,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return camelize<SystemEvent>(row!);
  }

  async appendMany(inputs: AppendEventInput[]): Promise<void> {
    for (const input of inputs) await this.append(input);
  }

  async listByTask(taskId: string, limit = 500): Promise<SystemEvent[]> {
    return camelizeAll<SystemEvent>(
      await this.db.query(`SELECT ${COLUMNS} FROM events WHERE task_id = $1 ORDER BY sequence ASC LIMIT $2`, [taskId, limit]),
    );
  }

  async listByProject(projectId: string, limit = 200): Promise<SystemEvent[]> {
    return camelizeAll<SystemEvent>(
      await this.db.query(`SELECT ${COLUMNS} FROM events WHERE project_id = $1 ORDER BY sequence DESC LIMIT $2`, [
        projectId,
        limit,
      ]),
    );
  }

  async listSince(projectId: string, sequence: string, limit = 200): Promise<SystemEvent[]> {
    return camelizeAll<SystemEvent>(
      await this.db.query(
        `SELECT ${COLUMNS} FROM events WHERE project_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3`,
        [projectId, sequence, limit],
      ),
    );
  }

  async countByType(projectId: string, eventType: EventType): Promise<number> {
    const row = await this.db.queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM events WHERE project_id = $1 AND event_type = $2',
      [projectId, eventType],
    );
    return Number(row?.count ?? '0');
  }
}
