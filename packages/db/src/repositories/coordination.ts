import { newId } from '@ai-engine/shared';
import type { DetectedConflict, ImpactManifest, ImpactResource, ImpactResourceKind, ResourceLock, TaskConflict } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const MANIFEST_COLUMNS = 'id, task_id, version, created_at';
const RESOURCE_COLUMNS = 'id, manifest_id, kind, identifier, access, source';
const CONFLICT_COLUMNS = 'id, task_id, other_task_id, kind, severity, resource, description, status, created_at';
const LOCK_COLUMNS = 'id, task_id, resource_kind, resource_key, mode, acquired_at, released_at';

export interface ImpactEntry extends ImpactResource {
  taskId: string;
}

export class ImpactRepository {
  constructor(private readonly db: Queryable) {}

  /** Every update creates a new manifest version so impact history is auditable. */
  async createManifest(taskId: string, resources: ImpactResource[]): Promise<ImpactManifest> {
    const next = await this.db.queryOne<{ next: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM impact_manifests WHERE task_id = $1',
      [taskId],
    );
    const row = await this.db.queryOne(
      `INSERT INTO impact_manifests (id, task_id, version) VALUES ($1, $2, $3) RETURNING ${MANIFEST_COLUMNS}`,
      [newId(), taskId, next?.next ?? 1],
    );
    const manifest = camelize<ImpactManifest>(row!);
    for (const resource of resources) {
      await this.db.query(
        'INSERT INTO impact_resources (id, manifest_id, kind, identifier, access, source) VALUES ($1, $2, $3, $4, $5, $6)',
        [newId(), manifest.id, resource.kind, resource.identifier, resource.access, resource.source],
      );
    }
    return manifest;
  }

  async latestManifest(taskId: string): Promise<{ manifest: ImpactManifest; resources: ImpactResource[] } | null> {
    const row = await this.db.queryOne(
      `SELECT ${MANIFEST_COLUMNS} FROM impact_manifests WHERE task_id = $1 ORDER BY version DESC LIMIT 1`,
      [taskId],
    );
    if (!row) return null;
    const manifest = camelize<ImpactManifest>(row);
    const resources = camelizeAll<ImpactResource>(
      await this.db.query(`SELECT ${RESOURCE_COLUMNS} FROM impact_resources WHERE manifest_id = $1`, [manifest.id]),
    );
    return { manifest, resources };
  }

  /** Impact of all other active tasks, used to detect overlapping resources. */
  async activeImpactExcluding(taskId: string): Promise<ImpactEntry[]> {
    const rows = await this.db.query<{
      task_id: string;
      kind: ImpactResourceKind;
      identifier: string;
      access: 'read' | 'write';
      source: string;
    }>(
      `SELECT DISTINCT ON (m.task_id, r.kind, r.identifier)
              m.task_id, r.kind, r.identifier, r.access, r.source
       FROM impact_resources r
       JOIN impact_manifests m ON m.id = r.manifest_id
       JOIN tasks t ON t.id = m.task_id
       WHERE m.task_id <> $1
         AND t.state NOT IN ('COMPLETED', 'STOPPED', 'ROLLED_BACK', 'DRAFT', 'FAILED')
         AND m.version = (SELECT MAX(version) FROM impact_manifests WHERE task_id = m.task_id)
       ORDER BY m.task_id, r.kind, r.identifier`,
      [taskId],
    );
    return rows.map((row) => ({
      taskId: row.task_id,
      kind: row.kind,
      identifier: row.identifier,
      access: row.access,
      source: row.source as ImpactResource['source'],
    }));
  }
}

export class ConflictRepository {
  constructor(private readonly db: Queryable) {}

  async record(taskId: string, conflict: DetectedConflict): Promise<TaskConflict> {
    const row = await this.db.queryOne(
      `INSERT INTO task_conflicts (id, task_id, other_task_id, kind, severity, resource, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${CONFLICT_COLUMNS}`,
      [newId(), taskId, conflict.otherTaskId, conflict.kind, conflict.severity, conflict.resource, conflict.description],
    );
    return camelize<TaskConflict>(row!);
  }

  async listOpen(taskId: string): Promise<TaskConflict[]> {
    return camelizeAll<TaskConflict>(
      await this.db.query(`SELECT ${CONFLICT_COLUMNS} FROM task_conflicts WHERE task_id = $1 AND status = 'OPEN' ORDER BY created_at DESC`, [
        taskId,
      ]),
    );
  }

  async listAllOpen(): Promise<TaskConflict[]> {
    return camelizeAll<TaskConflict>(
      await this.db.query(`SELECT ${CONFLICT_COLUMNS} FROM task_conflicts WHERE status = 'OPEN' ORDER BY created_at DESC`),
    );
  }

  async resolve(id: string, status: 'RESOLVED' | 'IGNORED'): Promise<void> {
    await this.db.query('UPDATE task_conflicts SET status = $2 WHERE id = $1', [id, status]);
  }

  async clearForTask(taskId: string): Promise<void> {
    await this.db.query(`UPDATE task_conflicts SET status = 'RESOLVED' WHERE task_id = $1 AND status = 'OPEN'`, [taskId]);
  }
}

export class LockRepository {
  constructor(private readonly db: Queryable) {}

  /** Hard locks are exclusive; a conflicting acquire returns null instead of throwing. */
  async acquire(input: {
    taskId: string;
    resourceKind: ImpactResourceKind;
    resourceKey: string;
    mode: 'HARD' | 'SOFT';
  }): Promise<ResourceLock | null> {
    const rows = await this.db.query(
      `INSERT INTO resource_locks (id, task_id, resource_kind, resource_key, mode)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING ${LOCK_COLUMNS}`,
      [newId(), input.taskId, input.resourceKind, input.resourceKey, input.mode],
    );
    const row = rows[0];
    return row ? camelize<ResourceLock>(row) : null;
  }

  async holder(resourceKind: string, resourceKey: string): Promise<ResourceLock | null> {
    const row = await this.db.queryOne(
      `SELECT ${LOCK_COLUMNS} FROM resource_locks
       WHERE resource_kind = $1 AND resource_key = $2 AND released_at IS NULL AND mode = 'HARD' LIMIT 1`,
      [resourceKind, resourceKey],
    );
    return row ? camelize<ResourceLock>(row) : null;
  }

  async listForTask(taskId: string): Promise<ResourceLock[]> {
    return camelizeAll<ResourceLock>(
      await this.db.query(`SELECT ${LOCK_COLUMNS} FROM resource_locks WHERE task_id = $1 AND released_at IS NULL`, [taskId]),
    );
  }

  async releaseAll(taskId: string): Promise<void> {
    await this.db.query('UPDATE resource_locks SET released_at = now() WHERE task_id = $1 AND released_at IS NULL', [taskId]);
  }
}

export class TaskDependencyRepository {
  constructor(private readonly db: Queryable) {}

  async add(taskId: string, dependsOnTaskId: string, relation: 'depends_on' | 'blocks' | 'conflicts_with' | 'shares_resource'): Promise<void> {
    await this.db.query(
      `INSERT INTO task_dependencies (id, task_id, depends_on_task_id, relation) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [newId(), taskId, dependsOnTaskId, relation],
    );
  }

  async listFor(taskId: string): Promise<{ id: string; taskId: string; dependsOnTaskId: string; relation: string }[]> {
    return camelizeAll(
      await this.db.query(
        'SELECT id, task_id, depends_on_task_id, relation FROM task_dependencies WHERE task_id = $1 OR depends_on_task_id = $1',
        [taskId],
      ),
    );
  }

  /** True while at least one blocking dependency has not reached a final state. */
  async hasUnmetDependencies(taskId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = $1 AND d.relation = 'depends_on'
         AND t.state NOT IN ('COMPLETED', 'PR_CREATED', 'STOPPED')`,
      [taskId],
    );
    return Number(row?.count ?? '0') > 0;
  }

  async remove(taskId: string, dependsOnTaskId: string): Promise<void> {
    await this.db.query('DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2', [
      taskId,
      dependsOnTaskId,
    ]);
  }
}

export class GitChangeRepository {
  constructor(private readonly db: Queryable) {}

  async replaceForTask(
    taskId: string,
    changes: { filePath: string; changeType: string; insertions: number; deletions: number }[],
  ): Promise<void> {
    await this.db.query('DELETE FROM git_changes WHERE task_id = $1', [taskId]);
    for (const change of changes) {
      await this.db.query(
        'INSERT INTO git_changes (id, task_id, file_path, change_type, insertions, deletions) VALUES ($1, $2, $3, $4, $5, $6)',
        [newId(), taskId, change.filePath, change.changeType, change.insertions, change.deletions],
      );
    }
  }

  async listForTask(taskId: string): Promise<{ filePath: string; changeType: string; insertions: number; deletions: number }[]> {
    return camelizeAll(
      await this.db.query('SELECT file_path, change_type, insertions, deletions FROM git_changes WHERE task_id = $1 ORDER BY file_path', [
        taskId,
      ]),
    );
  }

  async recordRef(taskId: string, refName: string, commitSha: string, kind: string): Promise<void> {
    await this.db.query('INSERT INTO git_refs (id, task_id, ref_name, commit_sha, kind) VALUES ($1, $2, $3, $4, $5)', [
      newId(),
      taskId,
      refName,
      commitSha,
      kind,
    ]);
  }
}
