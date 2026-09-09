import { createLogger } from '@ai-engine/shared';
import type { DetectedConflict, ImpactResource, ImpactResourceKind } from '@ai-engine/domain';
import { requiresHardLock } from '@ai-engine/domain';
import { ConflictRepository, ImpactRepository, LockRepository, type Queryable } from '@ai-engine/db';

const logger = createLogger('conflict-engine');

const KIND_TO_CONFLICT: Record<string, DetectedConflict['kind']> = {
  file: 'git',
  symbol: 'symbol',
  module: 'semantic',
  database_table: 'schema',
  database_column: 'schema',
  migration: 'migration',
  api: 'contract',
  event: 'contract',
  contract: 'contract',
  domain: 'semantic',
  invariant: 'invariant',
};

function severityFor(kind: DetectedConflict['kind'], bothWrite: boolean): DetectedConflict['severity'] {
  if (!bothWrite) return 'info';
  if (kind === 'migration' || kind === 'schema' || kind === 'contract' || kind === 'invariant') return 'blocking';
  if (kind === 'symbol') return 'blocking';
  return 'warning';
}

/**
 * Keeps the active task graph honest. Every impact manifest update triggers a
 * reevaluation, and a blocking overlap pauses the task rather than racing.
 */
export class ConflictEngine {
  private readonly impact: ImpactRepository;
  private readonly conflicts: ConflictRepository;
  private readonly locks: LockRepository;

  constructor(db: Queryable) {
    this.impact = new ImpactRepository(db);
    this.conflicts = new ConflictRepository(db);
    this.locks = new LockRepository(db);
  }

  async updateImpact(taskId: string, resources: ImpactResource[]): Promise<DetectedConflict[]> {
    await this.impact.createManifest(taskId, resources);
    return this.evaluate(taskId);
  }

  /** Compares this task's latest manifest against every other active task. */
  async evaluate(taskId: string): Promise<DetectedConflict[]> {
    const own = await this.impact.latestManifest(taskId);
    if (!own) return [];
    const others = await this.impact.activeImpactExcluding(taskId);

    const detected: DetectedConflict[] = [];
    for (const resource of own.resources) {
      for (const other of others) {
        if (other.kind !== resource.kind || other.identifier !== resource.identifier) continue;
        const bothWrite = resource.access === 'write' && other.access === 'write';
        if (!bothWrite && resource.access === 'read' && other.access === 'read') continue;
        const kind = KIND_TO_CONFLICT[resource.kind] ?? 'semantic';
        detected.push({
          kind,
          severity: severityFor(kind, bothWrite),
          resource: `${resource.kind}:${resource.identifier}`,
          description: bothWrite
            ? `Both tasks write ${resource.kind} ${resource.identifier}.`
            : `This task ${resource.access}s ${resource.kind} ${resource.identifier} while another task writes it.`,
          otherTaskId: other.taskId,
        });
      }
    }

    await this.conflicts.clearForTask(taskId);
    for (const conflict of detected) await this.conflicts.record(taskId, conflict);
    if (detected.length > 0) {
      logger.warn('conflicts detected', { taskId, count: detected.length });
    }
    return detected;
  }

  /**
   * Takes hard locks on critical resources. A refused lock means another task
   * owns the migration chain or a public contract and this one must wait.
   */
  async acquireLocks(
    taskId: string,
    resources: ImpactResource[],
  ): Promise<{ acquired: string[]; blockedBy: { resource: string; taskId: string }[] }> {
    const acquired: string[] = [];
    const blockedBy: { resource: string; taskId: string }[] = [];

    for (const resource of resources) {
      if (resource.access !== 'write') continue;
      const mode = requiresHardLock(resource.kind) ? 'HARD' : 'SOFT';
      const key = `${resource.kind}:${resource.identifier}`;
      const existing = mode === 'HARD' ? await this.locks.holder(resource.kind, resource.identifier) : null;
      if (existing && existing.taskId !== taskId) {
        blockedBy.push({ resource: key, taskId: existing.taskId });
        continue;
      }
      const lock = await this.locks.acquire({
        taskId,
        resourceKind: resource.kind as ImpactResourceKind,
        resourceKey: resource.identifier,
        mode,
      });
      if (lock) acquired.push(key);
    }

    return { acquired, blockedBy };
  }

  async releaseLocks(taskId: string): Promise<void> {
    await this.locks.releaseAll(taskId);
  }

  async openConflicts(taskId: string) {
    return this.conflicts.listOpen(taskId);
  }

  async allOpenConflicts() {
    return this.conflicts.listAllOpen();
  }

  async blockingConflicts(taskId: string): Promise<DetectedConflict[]> {
    const open = await this.conflicts.listOpen(taskId);
    return open
      .filter((conflict) => conflict.severity === 'blocking')
      .map((conflict) => ({
        kind: conflict.kind,
        severity: conflict.severity,
        resource: conflict.resource,
        description: conflict.description,
        otherTaskId: conflict.otherTaskId,
      }));
  }
}
