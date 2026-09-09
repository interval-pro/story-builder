import { createLogger } from '@ai-engine/shared';
import type { KnowledgeEntity, KnowledgeSnapshot } from '@ai-engine/domain';
import { KnowledgeRepository, type Queryable } from '@ai-engine/db';
import { extractProjectKnowledge, summarizeExtraction, type ExtractionResult } from './extract';

const logger = createLogger('project-knowledge');

/**
 * Knowledge is bound to a Git commit. A task keeps the snapshot it started
 * with, so knowledge never changes underneath a running task.
 */
export class KnowledgeService {
  private readonly repository: KnowledgeRepository;

  constructor(db: Queryable) {
    this.repository = new KnowledgeRepository(db);
  }

  async buildSnapshot(input: {
    projectId: string;
    gitCommit: string;
    repositoryPath: string;
    maxFiles?: number;
  }): Promise<{ snapshot: KnowledgeSnapshot; extraction: ExtractionResult }> {
    const snapshot = await this.repository.createSnapshot(input.projectId, input.gitCommit);
    const extraction = await extractProjectKnowledge(input.repositoryPath, { maxFiles: input.maxFiles });

    const created = await this.repository.addEntities(
      snapshot.id,
      extraction.entities.map((entity) => ({
        kind: entity.kind,
        name: entity.name,
        path: entity.path,
        signature: entity.signature,
        summary: entity.summary,
        metadata: entity.metadata,
      })),
    );

    const keyToId = new Map<string, string>();
    extraction.entities.forEach((entity, index) => {
      const key = `${entity.kind}:${entity.name}:${entity.path ?? ''}`;
      const stored = created[index];
      if (stored) keyToId.set(key, stored.id);
    });

    const edges = extraction.edges
      .map((edge) => ({
        fromEntityId: keyToId.get(edge.from),
        toEntityId: keyToId.get(edge.to),
        relation: edge.relation,
        metadata: edge.metadata ?? {},
      }))
      .filter((edge): edge is { fromEntityId: string; toEntityId: string; relation: string; metadata: Record<string, unknown> } =>
        Boolean(edge.fromEntityId && edge.toEntityId),
      );

    await this.repository.addEdges(snapshot.id, edges);
    const ready = await this.repository.markReady(snapshot.id);
    logger.info('knowledge snapshot built', {
      snapshotId: ready.id,
      entities: created.length,
      edges: edges.length,
      commit: input.gitCommit,
    });
    return { snapshot: ready, extraction };
  }

  async latest(projectId: string): Promise<KnowledgeSnapshot | null> {
    return this.repository.latestReady(projectId);
  }

  async summarize(snapshotId: string): Promise<string> {
    const entities = await this.repository.listEntities(snapshotId);
    return summarizeExtraction({ entities: entities.map((entity) => ({ ...entity, metadata: entity.metadata })), edges: [] });
  }

  async search(snapshotId: string, term: string): Promise<KnowledgeEntity[]> {
    return this.repository.searchEntities(snapshotId, term);
  }

  /** Everything that transitively depends on the given entities. */
  async impactOf(snapshotId: string, names: string[]): Promise<KnowledgeEntity[]> {
    const matches: KnowledgeEntity[] = [];
    for (const name of names) {
      matches.push(...(await this.repository.searchEntities(snapshotId, name, 10)));
    }
    const ids = [...new Set(matches.map((entity) => entity.id))];
    return this.repository.impactNeighbourhood(snapshotId, ids, 2);
  }

  async listSnapshots(projectId: string): Promise<KnowledgeSnapshot[]> {
    return this.repository.listSnapshots(projectId);
  }

  async listEntities(snapshotId: string, kind?: string): Promise<KnowledgeEntity[]> {
    return this.repository.listEntities(snapshotId, kind);
  }
}
