import { newId, NotFoundError } from '@ai-engine/shared';
import type { Approval, Review, ReviewDocument, ReviewNote, ReviewVersion } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const REVIEW_COLUMNS = 'id, task_id, kind, current_version, status, created_at, updated_at';
const VERSION_COLUMNS = 'id, review_id, version, document, markdown, generated_by_run_id, created_at';
const NOTE_COLUMNS = `id, review_id, review_version_id, section_key, anchor_text, anchor_start, anchor_end,
  note, status, created_by, created_at`;
const APPROVAL_COLUMNS = 'id, task_id, kind, review_version_id, decision, comment, decided_by, decided_at';

export class ReviewRepository {
  constructor(private readonly db: Queryable) {}

  async create(taskId: string, kind: Review['kind'] = 'ENGINEERING'): Promise<Review> {
    const row = await this.db.queryOne(
      `INSERT INTO reviews (id, task_id, kind) VALUES ($1, $2, $3) RETURNING ${REVIEW_COLUMNS}`,
      [newId(), taskId, kind],
    );
    return camelize<Review>(row!);
  }

  async findById(id: string): Promise<Review | null> {
    const row = await this.db.queryOne(`SELECT ${REVIEW_COLUMNS} FROM reviews WHERE id = $1`, [id]);
    return row ? camelize<Review>(row) : null;
  }

  async getById(id: string): Promise<Review> {
    const review = await this.findById(id);
    if (!review) throw new NotFoundError('Review', id);
    return review;
  }

  async findCurrentForTask(taskId: string, kind: Review['kind'] = 'ENGINEERING'): Promise<Review | null> {
    const row = await this.db.queryOne(
      `SELECT ${REVIEW_COLUMNS} FROM reviews WHERE task_id = $1 AND kind = $2 AND status <> 'SUPERSEDED'
       ORDER BY created_at DESC LIMIT 1`,
      [taskId, kind],
    );
    return row ? camelize<Review>(row) : null;
  }

  async listByTask(taskId: string): Promise<Review[]> {
    return camelizeAll<Review>(
      await this.db.query(`SELECT ${REVIEW_COLUMNS} FROM reviews WHERE task_id = $1 ORDER BY created_at ASC`, [taskId]),
    );
  }

  async setStatus(id: string, status: Review['status']): Promise<Review> {
    const row = await this.db.queryOne(
      `UPDATE reviews SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${REVIEW_COLUMNS}`,
      [id, status],
    );
    if (!row) throw new NotFoundError('Review', id);
    return camelize<Review>(row);
  }

  /** Appends a new immutable review version and bumps the review pointer. */
  async addVersion(input: {
    reviewId: string;
    document: ReviewDocument;
    markdown: string;
    generatedByRunId?: string | null;
  }): Promise<ReviewVersion> {
    const reviewRow = await this.db.queryOne<{ current_version: number }>(
      `UPDATE reviews SET current_version = current_version + 1, status = 'READY', updated_at = now()
       WHERE id = $1 RETURNING current_version`,
      [input.reviewId],
    );
    if (!reviewRow) throw new NotFoundError('Review', input.reviewId);
    const row = await this.db.queryOne(
      `INSERT INTO review_versions (id, review_id, version, document, markdown, generated_by_run_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${VERSION_COLUMNS}`,
      [
        newId(),
        input.reviewId,
        reviewRow.current_version,
        JSON.stringify(input.document),
        input.markdown,
        input.generatedByRunId ?? null,
      ],
    );
    return camelize<ReviewVersion>(row!);
  }

  async getVersion(id: string): Promise<ReviewVersion> {
    const row = await this.db.queryOne(`SELECT ${VERSION_COLUMNS} FROM review_versions WHERE id = $1`, [id]);
    if (!row) throw new NotFoundError('ReviewVersion', id);
    return camelize<ReviewVersion>(row);
  }

  async listVersions(reviewId: string): Promise<ReviewVersion[]> {
    return camelizeAll<ReviewVersion>(
      await this.db.query(`SELECT ${VERSION_COLUMNS} FROM review_versions WHERE review_id = $1 ORDER BY version ASC`, [
        reviewId,
      ]),
    );
  }

  async getLatestVersion(reviewId: string): Promise<ReviewVersion | null> {
    const row = await this.db.queryOne(
      `SELECT ${VERSION_COLUMNS} FROM review_versions WHERE review_id = $1 ORDER BY version DESC LIMIT 1`,
      [reviewId],
    );
    return row ? camelize<ReviewVersion>(row) : null;
  }

  async addNote(input: {
    reviewId: string;
    reviewVersionId: string;
    sectionKey?: string | null;
    anchorText: string;
    anchorStart?: number | null;
    anchorEnd?: number | null;
    note: string;
    createdBy?: string;
  }): Promise<ReviewNote> {
    const row = await this.db.queryOne(
      `INSERT INTO review_notes (id, review_id, review_version_id, section_key, anchor_text, anchor_start, anchor_end, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${NOTE_COLUMNS}`,
      [
        newId(),
        input.reviewId,
        input.reviewVersionId,
        input.sectionKey ?? null,
        input.anchorText,
        input.anchorStart ?? null,
        input.anchorEnd ?? null,
        input.note,
        input.createdBy ?? 'human',
      ],
    );
    return camelize<ReviewNote>(row!);
  }

  async listNotes(reviewId: string): Promise<ReviewNote[]> {
    return camelizeAll<ReviewNote>(
      await this.db.query(`SELECT ${NOTE_COLUMNS} FROM review_notes WHERE review_id = $1 ORDER BY created_at ASC`, [
        reviewId,
      ]),
    );
  }

  async listOpenNotes(reviewId: string): Promise<ReviewNote[]> {
    return camelizeAll<ReviewNote>(
      await this.db.query(
        `SELECT ${NOTE_COLUMNS} FROM review_notes WHERE review_id = $1 AND status = 'OPEN' ORDER BY created_at ASC`,
        [reviewId],
      ),
    );
  }

  async markNotesAddressed(reviewId: string, noteIds: string[]): Promise<void> {
    if (noteIds.length === 0) return;
    await this.db.query(`UPDATE review_notes SET status = 'ADDRESSED' WHERE review_id = $1 AND id = ANY($2::uuid[])`, [
      reviewId,
      noteIds,
    ]);
  }
}

export class ApprovalRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: {
    taskId: string;
    kind: Approval['kind'];
    reviewVersionId?: string | null;
    decision: Approval['decision'];
    comment?: string | null;
    decidedBy?: string;
  }): Promise<Approval> {
    const row = await this.db.queryOne(
      `INSERT INTO approvals (id, task_id, kind, review_version_id, decision, comment, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${APPROVAL_COLUMNS}`,
      [
        newId(),
        input.taskId,
        input.kind,
        input.reviewVersionId ?? null,
        input.decision,
        input.comment ?? null,
        input.decidedBy ?? 'human',
      ],
    );
    return camelize<Approval>(row!);
  }

  async listByTask(taskId: string): Promise<Approval[]> {
    return camelizeAll<Approval>(
      await this.db.query(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE task_id = $1 ORDER BY decided_at ASC`, [
        taskId,
      ]),
    );
  }

  async findLatest(taskId: string, kind: Approval['kind']): Promise<Approval | null> {
    const row = await this.db.queryOne(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE task_id = $1 AND kind = $2 ORDER BY decided_at DESC LIMIT 1`,
      [taskId, kind],
    );
    return row ? camelize<Approval>(row) : null;
  }

  /** The approved review version is the only intent the implementation agent may act on. */
  async findApprovedReviewVersionId(taskId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ review_version_id: string | null }>(
      `SELECT review_version_id FROM approvals
       WHERE task_id = $1 AND kind = 'REVIEW' AND decision = 'APPROVED'
       ORDER BY decided_at DESC LIMIT 1`,
      [taskId],
    );
    return row?.review_version_id ?? null;
  }
}
