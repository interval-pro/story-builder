import { HttpRouter } from '@ai-engine/shared';
import { resolveProjectId, requireBody, type ApiContext } from '../context';

/** Project Brain: principles, invariants and the knowledge graph. */
export function registerBrainRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/project-brain', async ({ query }) => {
    const projectId = await resolveProjectId(context, query.get('projectId'));
    const [principles, invariants] = await Promise.all([
      context.repos.principles.listAll(projectId),
      context.repos.invariants.listAll(projectId),
    ]);
    return { principles, invariants };
  });

  router.post('/api/project-brain/principles', async ({ body, query }) => {
    const projectId = await resolveProjectId(context, query.get('projectId'));
    const input = requireBody<{ category: string; statement: string; scope?: string }>(body, ['category', 'statement']);
    const principle = await context.repos.principles.create({
      projectId,
      category: input.category,
      statement: input.statement,
      scope: input.scope ?? 'global',
      strength: 0.8,
    });
    return { principle };
  });

  router.put('/api/project-brain/principles/:id', async ({ params, body }) => {
    const input = (body ?? {}) as { statement?: string; category?: string; scope?: string; status?: 'ACTIVE' | 'SUPERSEDED' | 'REJECTED' };
    return { principle: await context.repos.principles.update(params['id']!, input) };
  });

  router.get('/api/project-brain/principles/:id/evidence', async ({ params }) => {
    return { evidence: await context.repos.principles.listEvidence(params['id']!) };
  });

  router.post('/api/project-brain/invariants', async ({ body, query }) => {
    const projectId = await resolveProjectId(context, query.get('projectId'));
    const input = requireBody<{ statement: string; scope?: string }>(body, ['statement']);
    const invariant = await context.repos.invariants.create({
      projectId,
      statement: input.statement,
      scope: input.scope ?? 'global',
      status: 'ACTIVE',
      confidence: 1,
    });
    return { invariant };
  });

  router.put('/api/project-brain/invariants/:id', async ({ params, body }) => {
    const input = requireBody<{ status: 'ACTIVE' | 'PROPOSED' | 'RETIRED' }>(body, ['status']);
    return { invariant: await context.repos.invariants.setStatus(params['id']!, input.status) };
  });

  router.get('/api/project-knowledge', async ({ query }) => {
    const projectId = await resolveProjectId(context, query.get('projectId'));
    const snapshots = await context.knowledge.listSnapshots(projectId);
    const snapshotId = query.get('snapshotId') ?? snapshots[0]?.id ?? null;
    if (!snapshotId) return { snapshots, snapshotId: null, entities: [], summary: null };
    const kind = query.get('kind');
    const entities = await context.knowledge.listEntities(snapshotId, kind ?? undefined);
    return {
      snapshots,
      snapshotId,
      entities: entities.slice(0, 500),
      total: entities.length,
      summary: await context.knowledge.summarize(snapshotId),
    };
  });

  router.get('/api/project-knowledge/search', async ({ query }) => {
    const projectId = await resolveProjectId(context, query.get('projectId'));
    const term = query.get('q') ?? '';
    const snapshot = await context.knowledge.latest(projectId);
    if (!snapshot || !term) return { entities: [] };
    return { entities: await context.knowledge.search(snapshot.id, term) };
  });
}
