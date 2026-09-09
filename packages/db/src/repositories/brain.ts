import { newId, NotFoundError } from '@ai-engine/shared';
import type { Invariant, Principle } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const PRINCIPLE_COLUMNS = `id, project_id, category, statement, scope, status, strength, evidence_count,
  supersedes_id, created_at, updated_at`;

export class PrincipleRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    projectId: string;
    category: string;
    statement: string;
    scope?: string;
    strength?: number;
    supersedesId?: string | null;
  }): Promise<Principle> {
    const row = await this.db.queryOne(
      `INSERT INTO project_brain_principles (id, project_id, category, statement, scope, strength, supersedes_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${PRINCIPLE_COLUMNS}`,
      [
        newId(),
        input.projectId,
        input.category,
        input.statement,
        input.scope ?? 'global',
        input.strength ?? 0.5,
        input.supersedesId ?? null,
      ],
    );
    return camelize<Principle>(row!);
  }

  async listActive(projectId: string): Promise<Principle[]> {
    return camelizeAll<Principle>(
      await this.db.query(
        `SELECT ${PRINCIPLE_COLUMNS} FROM project_brain_principles
         WHERE project_id = $1 AND status = 'ACTIVE'
         ORDER BY strength DESC, evidence_count DESC, created_at ASC`,
        [projectId],
      ),
    );
  }

  async listAll(projectId: string): Promise<Principle[]> {
    return camelizeAll<Principle>(
      await this.db.query(
        `SELECT ${PRINCIPLE_COLUMNS} FROM project_brain_principles WHERE project_id = $1 ORDER BY created_at DESC`,
        [projectId],
      ),
    );
  }

  async findSimilar(projectId: string, statement: string): Promise<Principle | null> {
    const row = await this.db.queryOne(
      `SELECT ${PRINCIPLE_COLUMNS} FROM project_brain_principles
       WHERE project_id = $1 AND status = 'ACTIVE' AND lower(statement) = lower($2) LIMIT 1`,
      [projectId, statement],
    );
    return row ? camelize<Principle>(row) : null;
  }

  /** Repeated evidence makes a principle stronger rather than duplicating it. */
  async reinforce(id: string, delta = 0.1): Promise<Principle> {
    const row = await this.db.queryOne(
      `UPDATE project_brain_principles
       SET evidence_count = evidence_count + 1,
           strength = LEAST(1.0, strength + $2),
           updated_at = now()
       WHERE id = $1 RETURNING ${PRINCIPLE_COLUMNS}`,
      [id, delta],
    );
    if (!row) throw new NotFoundError('Principle', id);
    return camelize<Principle>(row);
  }

  async update(id: string, patch: Partial<Pick<Principle, 'statement' | 'category' | 'scope' | 'status' | 'strength'>>): Promise<Principle> {
    const row = await this.db.queryOne(
      `UPDATE project_brain_principles SET
         statement = COALESCE($2, statement),
         category = COALESCE($3, category),
         scope = COALESCE($4, scope),
         status = COALESCE($5, status),
         strength = COALESCE($6, strength),
         updated_at = now()
       WHERE id = $1 RETURNING ${PRINCIPLE_COLUMNS}`,
      [id, patch.statement ?? null, patch.category ?? null, patch.scope ?? null, patch.status ?? null, patch.strength ?? null],
    );
    if (!row) throw new NotFoundError('Principle', id);
    return camelize<Principle>(row);
  }

  async addEvidence(input: {
    principleId: string;
    taskId?: string | null;
    reviewNoteId?: string | null;
    evidence: string;
  }): Promise<void> {
    await this.db.query(
      'INSERT INTO principle_evidence (id, principle_id, task_id, review_note_id, evidence) VALUES ($1, $2, $3, $4, $5)',
      [newId(), input.principleId, input.taskId ?? null, input.reviewNoteId ?? null, input.evidence],
    );
  }

  async listEvidence(principleId: string): Promise<{ id: string; evidence: string; createdAt: string }[]> {
    return camelizeAll(
      await this.db.query('SELECT id, evidence, created_at FROM principle_evidence WHERE principle_id = $1 ORDER BY created_at ASC', [
        principleId,
      ]),
    );
  }
}

const INVARIANT_COLUMNS = 'id, project_id, statement, scope, status, confidence, created_at';

export class InvariantRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    projectId: string;
    statement: string;
    scope?: string;
    status?: Invariant['status'];
    confidence?: number;
  }): Promise<Invariant> {
    const row = await this.db.queryOne(
      `INSERT INTO invariants (id, project_id, statement, scope, status, confidence)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${INVARIANT_COLUMNS}`,
      [newId(), input.projectId, input.statement, input.scope ?? 'global', input.status ?? 'PROPOSED', input.confidence ?? 0.5],
    );
    return camelize<Invariant>(row!);
  }

  async listActive(projectId: string): Promise<Invariant[]> {
    return camelizeAll<Invariant>(
      await this.db.query(
        `SELECT ${INVARIANT_COLUMNS} FROM invariants WHERE project_id = $1 AND status IN ('ACTIVE', 'PROPOSED')
         ORDER BY confidence DESC, created_at ASC`,
        [projectId],
      ),
    );
  }

  async listAll(projectId: string): Promise<Invariant[]> {
    return camelizeAll<Invariant>(
      await this.db.query(`SELECT ${INVARIANT_COLUMNS} FROM invariants WHERE project_id = $1 ORDER BY created_at DESC`, [
        projectId,
      ]),
    );
  }

  async findByStatement(projectId: string, statement: string): Promise<Invariant | null> {
    const row = await this.db.queryOne(
      `SELECT ${INVARIANT_COLUMNS} FROM invariants WHERE project_id = $1 AND lower(statement) = lower($2) LIMIT 1`,
      [projectId, statement],
    );
    return row ? camelize<Invariant>(row) : null;
  }

  async setStatus(id: string, status: Invariant['status']): Promise<Invariant> {
    const row = await this.db.queryOne(`UPDATE invariants SET status = $2 WHERE id = $1 RETURNING ${INVARIANT_COLUMNS}`, [
      id,
      status,
    ]);
    if (!row) throw new NotFoundError('Invariant', id);
    return camelize<Invariant>(row);
  }

  async addEvidence(invariantId: string, source: string, evidence: string): Promise<void> {
    await this.db.query('INSERT INTO invariant_evidence (id, invariant_id, source, evidence) VALUES ($1, $2, $3, $4)', [
      newId(),
      invariantId,
      source,
      evidence,
    ]);
  }
}
