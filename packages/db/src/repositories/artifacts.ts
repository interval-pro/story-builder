import { newId, NotFoundError } from '@ai-engine/shared';
import type { ArtifactRecord } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const COLUMNS = `id, project_id, task_id, run_id, kind, content_type, size_bytes, storage_path,
  checksum, metadata, created_at`;

export class ArtifactRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id?: string;
    projectId: string;
    taskId?: string | null;
    runId?: string | null;
    kind: string;
    contentType?: string;
    sizeBytes: number;
    storagePath: string;
    checksum: string;
    metadata?: Record<string, unknown>;
  }): Promise<ArtifactRecord> {
    const row = await this.db.queryOne(
      `INSERT INTO artifacts (id, project_id, task_id, run_id, kind, content_type, size_bytes, storage_path, checksum, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COLUMNS}`,
      [
        input.id ?? newId(),
        input.projectId,
        input.taskId ?? null,
        input.runId ?? null,
        input.kind,
        input.contentType ?? 'text/plain',
        input.sizeBytes,
        input.storagePath,
        input.checksum,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return camelize<ArtifactRecord>(row!);
  }

  async getById(id: string): Promise<ArtifactRecord> {
    const row = await this.db.queryOne(`SELECT ${COLUMNS} FROM artifacts WHERE id = $1`, [id]);
    if (!row) throw new NotFoundError('Artifact', id);
    return camelize<ArtifactRecord>(row);
  }

  async listByTask(taskId: string, kind?: string): Promise<ArtifactRecord[]> {
    const rows = kind
      ? await this.db.query(
          `SELECT ${COLUMNS} FROM artifacts WHERE task_id = $1 AND kind = $2 ORDER BY created_at DESC`,
          [taskId, kind],
        )
      : await this.db.query(`SELECT ${COLUMNS} FROM artifacts WHERE task_id = $1 ORDER BY created_at DESC`, [taskId]);
    return camelizeAll<ArtifactRecord>(rows);
  }

  async latestByKind(taskId: string, kind: string): Promise<ArtifactRecord | null> {
    const row = await this.db.queryOne(
      `SELECT ${COLUMNS} FROM artifacts WHERE task_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1`,
      [taskId, kind],
    );
    return row ? camelize<ArtifactRecord>(row) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.query('DELETE FROM artifacts WHERE id = $1', [id]);
  }
}
