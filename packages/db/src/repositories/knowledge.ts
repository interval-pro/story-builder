import { newId, NotFoundError } from '@ai-engine/shared';
import type { KnowledgeEdge, KnowledgeEntity, KnowledgeSnapshot, RuntimeManifest, RuntimeManifestDocument } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const SNAPSHOT_COLUMNS = 'id, project_id, sequence, git_commit, status, created_at';
const ENTITY_COLUMNS = 'id, snapshot_id, kind, name, path, signature, summary, metadata';
const EDGE_COLUMNS = 'id, snapshot_id, from_entity_id, to_entity_id, relation, metadata';

export class KnowledgeRepository {
  constructor(private readonly db: Queryable) {}

  async createSnapshot(projectId: string, gitCommit: string): Promise<KnowledgeSnapshot> {
    const next = await this.db.queryOne<{ next: number }>(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM knowledge_snapshots WHERE project_id = $1',
      [projectId],
    );
    const row = await this.db.queryOne(
      `INSERT INTO knowledge_snapshots (id, project_id, sequence, git_commit)
       VALUES ($1, $2, $3, $4) RETURNING ${SNAPSHOT_COLUMNS}`,
      [newId(), projectId, next?.next ?? 1, gitCommit],
    );
    return camelize<KnowledgeSnapshot>(row!);
  }

  async markReady(id: string): Promise<KnowledgeSnapshot> {
    const row = await this.db.queryOne(
      `UPDATE knowledge_snapshots SET status = 'READY' WHERE id = $1 RETURNING ${SNAPSHOT_COLUMNS}`,
      [id],
    );
    if (!row) throw new NotFoundError('KnowledgeSnapshot', id);
    return camelize<KnowledgeSnapshot>(row);
  }

  async latestReady(projectId: string): Promise<KnowledgeSnapshot | null> {
    const row = await this.db.queryOne(
      `SELECT ${SNAPSHOT_COLUMNS} FROM knowledge_snapshots WHERE project_id = $1 AND status = 'READY'
       ORDER BY sequence DESC LIMIT 1`,
      [projectId],
    );
    return row ? camelize<KnowledgeSnapshot>(row) : null;
  }

  async getSnapshot(id: string): Promise<KnowledgeSnapshot> {
    const row = await this.db.queryOne(`SELECT ${SNAPSHOT_COLUMNS} FROM knowledge_snapshots WHERE id = $1`, [id]);
    if (!row) throw new NotFoundError('KnowledgeSnapshot', id);
    return camelize<KnowledgeSnapshot>(row);
  }

  async listSnapshots(projectId: string, limit = 20): Promise<KnowledgeSnapshot[]> {
    return camelizeAll<KnowledgeSnapshot>(
      await this.db.query(
        `SELECT ${SNAPSHOT_COLUMNS} FROM knowledge_snapshots WHERE project_id = $1 ORDER BY sequence DESC LIMIT $2`,
        [projectId, limit],
      ),
    );
  }

  async addEntities(
    snapshotId: string,
    entities: { kind: string; name: string; path?: string | null; signature?: string | null; summary?: string | null; metadata?: Record<string, unknown> }[],
  ): Promise<KnowledgeEntity[]> {
    const created: KnowledgeEntity[] = [];
    for (const entity of entities) {
      const row = await this.db.queryOne(
        `INSERT INTO knowledge_entities (id, snapshot_id, kind, name, path, signature, summary, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${ENTITY_COLUMNS}`,
        [
          newId(),
          snapshotId,
          entity.kind,
          entity.name,
          entity.path ?? null,
          entity.signature ?? null,
          entity.summary ?? null,
          JSON.stringify(entity.metadata ?? {}),
        ],
      );
      created.push(camelize<KnowledgeEntity>(row!));
    }
    return created;
  }

  async addEdges(
    snapshotId: string,
    edges: { fromEntityId: string; toEntityId: string; relation: string; metadata?: Record<string, unknown> }[],
  ): Promise<KnowledgeEdge[]> {
    const created: KnowledgeEdge[] = [];
    for (const edge of edges) {
      const row = await this.db.queryOne(
        `INSERT INTO knowledge_edges (id, snapshot_id, from_entity_id, to_entity_id, relation, metadata)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${EDGE_COLUMNS}`,
        [newId(), snapshotId, edge.fromEntityId, edge.toEntityId, edge.relation, JSON.stringify(edge.metadata ?? {})],
      );
      created.push(camelize<KnowledgeEdge>(row!));
    }
    return created;
  }

  async listEntities(snapshotId: string, kind?: string): Promise<KnowledgeEntity[]> {
    const rows = kind
      ? await this.db.query(`SELECT ${ENTITY_COLUMNS} FROM knowledge_entities WHERE snapshot_id = $1 AND kind = $2 ORDER BY name`, [snapshotId, kind])
      : await this.db.query(`SELECT ${ENTITY_COLUMNS} FROM knowledge_entities WHERE snapshot_id = $1 ORDER BY kind, name`, [snapshotId]);
    return camelizeAll<KnowledgeEntity>(rows);
  }

  async searchEntities(snapshotId: string, term: string, limit = 40): Promise<KnowledgeEntity[]> {
    return camelizeAll<KnowledgeEntity>(
      await this.db.query(
        `SELECT ${ENTITY_COLUMNS} FROM knowledge_entities
         WHERE snapshot_id = $1 AND (name ILIKE '%' || $2 || '%' OR path ILIKE '%' || $2 || '%')
         ORDER BY name LIMIT $3`,
        [snapshotId, term, limit],
      ),
    );
  }

  async listEdges(snapshotId: string): Promise<KnowledgeEdge[]> {
    return camelizeAll<KnowledgeEdge>(
      await this.db.query(`SELECT ${EDGE_COLUMNS} FROM knowledge_edges WHERE snapshot_id = $1`, [snapshotId]),
    );
  }

  /** Walks the graph outwards from a set of entities to estimate blast radius. */
  async impactNeighbourhood(snapshotId: string, entityIds: string[], depth = 2): Promise<KnowledgeEntity[]> {
    if (entityIds.length === 0) return [];
    const rows = await this.db.query(
      `WITH RECURSIVE reachable(id, level) AS (
         SELECT unnest($2::uuid[]), 0
         UNION
         SELECT e.from_entity_id, r.level + 1
         FROM knowledge_edges e JOIN reachable r ON e.to_entity_id = r.id
         WHERE e.snapshot_id = $1 AND r.level < $3
       )
       SELECT DISTINCT k.id, k.snapshot_id, k.kind, k.name, k.path, k.signature, k.summary, k.metadata
       FROM knowledge_entities k JOIN reachable r ON r.id = k.id
       WHERE k.snapshot_id = $1`,
      [snapshotId, entityIds, depth],
    );
    return camelizeAll<KnowledgeEntity>(rows);
  }
}

const MANIFEST_COLUMNS = 'id, project_id, version, manifest, validated, validation_log, created_at';

export class RuntimeManifestRepository {
  constructor(private readonly db: Queryable) {}

  async create(projectId: string, manifest: RuntimeManifestDocument): Promise<RuntimeManifest> {
    const next = await this.db.queryOne<{ next: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM runtime_manifests WHERE project_id = $1',
      [projectId],
    );
    const row = await this.db.queryOne(
      `INSERT INTO runtime_manifests (id, project_id, version, manifest)
       VALUES ($1, $2, $3, $4) RETURNING ${MANIFEST_COLUMNS}`,
      [newId(), projectId, next?.next ?? 1, JSON.stringify(manifest)],
    );
    return camelize<RuntimeManifest>(row!);
  }

  async markValidated(id: string, validated: boolean, log: string): Promise<RuntimeManifest> {
    const row = await this.db.queryOne(
      `UPDATE runtime_manifests SET validated = $2, validation_log = $3 WHERE id = $1 RETURNING ${MANIFEST_COLUMNS}`,
      [id, validated, log.slice(0, 100_000)],
    );
    if (!row) throw new NotFoundError('RuntimeManifest', id);
    return camelize<RuntimeManifest>(row);
  }

  async latest(projectId: string): Promise<RuntimeManifest | null> {
    const row = await this.db.queryOne(
      `SELECT ${MANIFEST_COLUMNS} FROM runtime_manifests WHERE project_id = $1 ORDER BY version DESC LIMIT 1`,
      [projectId],
    );
    return row ? camelize<RuntimeManifest>(row) : null;
  }
}
