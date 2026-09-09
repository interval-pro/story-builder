import { createLogger } from '@ai-engine/shared';
import type { Invariant, Principle } from '@ai-engine/domain';
import { InvariantRepository, PrincipleRepository, type Queryable } from '@ai-engine/db';

const logger = createLogger('project-brain');

export interface LearnedPrinciple {
  category: string;
  statement: string;
  scope: string;
  evidence: string;
}

export interface LearnedInvariant {
  statement: string;
  scope: string;
  confidence: number;
  evidence: string;
}

/** Word overlap is enough to catch a restatement of an existing principle. */
function similarity(a: string, b: string): number {
  const tokenize = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length > 3),
    );
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / Math.min(left.size, right.size);
}

/**
 * The persistent memory of how this team makes decisions. Repeated evidence
 * strengthens an existing principle instead of creating a near duplicate.
 */
export class ProjectBrain {
  private readonly principles: PrincipleRepository;
  private readonly invariants: InvariantRepository;

  constructor(db: Queryable) {
    this.principles = new PrincipleRepository(db);
    this.invariants = new InvariantRepository(db);
  }

  async activePrinciples(projectId: string): Promise<Principle[]> {
    return this.principles.listActive(projectId);
  }

  async activeInvariants(projectId: string): Promise<Invariant[]> {
    return this.invariants.listActive(projectId);
  }

  async recordPrinciple(
    projectId: string,
    learned: LearnedPrinciple,
    context: { taskId?: string | null; reviewNoteId?: string | null } = {},
  ): Promise<{ principle: Principle; created: boolean }> {
    const existing = await this.principles.listActive(projectId);
    const match = existing.find((principle) => similarity(principle.statement, learned.statement) >= 0.6);

    if (match) {
      const principle = await this.principles.reinforce(match.id);
      await this.principles.addEvidence({
        principleId: principle.id,
        taskId: context.taskId ?? null,
        reviewNoteId: context.reviewNoteId ?? null,
        evidence: learned.evidence,
      });
      logger.info('principle reinforced', { id: principle.id, strength: principle.strength });
      return { principle, created: false };
    }

    const principle = await this.principles.create({
      projectId,
      category: learned.category,
      statement: learned.statement,
      scope: learned.scope,
      strength: 0.5,
    });
    await this.principles.addEvidence({
      principleId: principle.id,
      taskId: context.taskId ?? null,
      reviewNoteId: context.reviewNoteId ?? null,
      evidence: learned.evidence,
    });
    logger.info('principle learned', { id: principle.id, category: principle.category });
    return { principle, created: true };
  }

  /** Invariants are added conservatively and start as proposals. */
  async recordInvariant(projectId: string, learned: LearnedInvariant): Promise<{ invariant: Invariant; created: boolean }> {
    const existing = await this.invariants.listActive(projectId);
    const match = existing.find((invariant) => similarity(invariant.statement, learned.statement) >= 0.7);
    if (match) {
      await this.invariants.addEvidence(match.id, 'learning', learned.evidence);
      return { invariant: match, created: false };
    }
    const invariant = await this.invariants.create({
      projectId,
      statement: learned.statement,
      scope: learned.scope,
      status: learned.confidence >= 0.8 ? 'ACTIVE' : 'PROPOSED',
      confidence: learned.confidence,
    });
    await this.invariants.addEvidence(invariant.id, 'learning', learned.evidence);
    return { invariant, created: true };
  }

  async promoteInvariant(id: string): Promise<Invariant> {
    return this.invariants.setStatus(id, 'ACTIVE');
  }

  async retireInvariant(id: string): Promise<Invariant> {
    return this.invariants.setStatus(id, 'RETIRED');
  }

  async supersede(projectId: string, oldId: string, learned: LearnedPrinciple): Promise<Principle> {
    await this.principles.update(oldId, { status: 'SUPERSEDED' });
    return this.principles.create({
      projectId,
      category: learned.category,
      statement: learned.statement,
      scope: learned.scope,
      supersedesId: oldId,
    });
  }
}
