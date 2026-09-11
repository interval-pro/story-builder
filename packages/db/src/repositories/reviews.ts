import { newId, NotFoundError } from '@ai-engine/shared';
import type {
  Approval,
  Review,
  ReviewDecision,
  ReviewDecisionRecord,
  ReviewDocument,
  ReviewNote,
  ReviewVersion,
} from '@ai-engine/domain';
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

const DECISION_COLUMNS = `id, task_id, review_version_id, key, question, detail, blocking, options, status,
  chosen_key, custom_answer, answered_by, answered_at, created_at`;

/**
 * The decisions a review version is waiting on.
 *
 * They were lines of prose in the open questions section, which meant nothing
 * could gate on them: a task could be approved with a blocking question
 * unanswered and the implementation would guess. Rows can be gated on.
 *
 * A decision's key is stable across regenerations, so an answer given against
 * version 2 is carried onto version 3 rather than asked again.
 */
export class ReviewDecisionRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Writes the decisions a new review version carries, keeping any answer
   * already given for the same key on an earlier version.
   *
   * Carrying the answer forward is the whole reason the key exists. Asking the
   * same question again after a regeneration that had nothing to do with it is
   * how a person learns to stop reading the questions.
   */
  async replaceForVersion(input: {
    taskId: string;
    reviewVersionId: string;
    decisions: ReviewDecision[];
  }): Promise<ReviewDecisionRecord[]> {
    const previous = await this.db.query<{
      key: string;
      status: string;
      chosen_key: string | null;
      custom_answer: string | null;
      answered_by: string | null;
      answered_at: Date | null;
    }>(
      `SELECT key, status, chosen_key, custom_answer, answered_by, answered_at
         FROM review_decisions WHERE task_id = $1 AND status = 'ANSWERED'`,
      [input.taskId],
    );
    const answered = new Map(previous.map((row) => [row.key, row]));

    await this.db.query('DELETE FROM review_decisions WHERE review_version_id = $1', [input.reviewVersionId]);

    const created: ReviewDecisionRecord[] = [];
    for (const decision of input.decisions) {
      const carried = answered.get(decision.key);
      const row = await this.db.queryOne(
        `INSERT INTO review_decisions (id, task_id, review_version_id, key, question, detail, blocking, options,
           status, chosen_key, custom_answer, answered_by, answered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
         RETURNING ${DECISION_COLUMNS}`,
        [
          newId(),
          input.taskId,
          input.reviewVersionId,
          decision.key,
          decision.question,
          decision.detail,
          decision.blocking,
          JSON.stringify(decision.options),
          carried ? 'ANSWERED' : 'OPEN',
          carried?.chosen_key ?? null,
          carried?.custom_answer ?? null,
          carried?.answered_by ?? null,
          carried?.answered_at ?? null,
        ],
      );
      created.push(camelize<ReviewDecisionRecord>(row!));
    }
    return created;
  }

  async listForVersion(reviewVersionId: string): Promise<ReviewDecisionRecord[]> {
    return camelizeAll<ReviewDecisionRecord>(
      await this.db.query(
        `SELECT ${DECISION_COLUMNS} FROM review_decisions WHERE review_version_id = $1 ORDER BY blocking DESC, created_at ASC`,
        [reviewVersionId],
      ),
    );
  }

  async listForTask(taskId: string): Promise<ReviewDecisionRecord[]> {
    return camelizeAll<ReviewDecisionRecord>(
      await this.db.query(
        `SELECT ${DECISION_COLUMNS} FROM review_decisions WHERE task_id = $1 ORDER BY created_at ASC`,
        [taskId],
      ),
    );
  }

  /** Answered decisions for a task, which is what the later phases are told. */
  async listAnswered(taskId: string): Promise<ReviewDecisionRecord[]> {
    return camelizeAll<ReviewDecisionRecord>(
      await this.db.query(
        `SELECT ${DECISION_COLUMNS} FROM review_decisions WHERE task_id = $1 AND status = 'ANSWERED'
          ORDER BY created_at ASC`,
        [taskId],
      ),
    );
  }

  /**
   * Answers a decision by task and key, whichever review raised it.
   *
   * A decision can come from the engineering review or from a supplemental one
   * the implementation opened when it found work outside the plan. The person
   * answering does not care which, and making the caller work it out is how the
   * supplemental ones ended up unanswerable.
   */
  async answerForTask(input: {
    taskId: string;
    key: string;
    chosenKey: string;
    customAnswer: string | null;
    answeredBy: string;
  }): Promise<ReviewDecisionRecord> {
    const row = await this.db.queryOne(
      `UPDATE review_decisions SET status = 'ANSWERED', chosen_key = $3, custom_answer = $4,
         answered_by = $5, answered_at = now()
       WHERE id = (
         SELECT id FROM review_decisions WHERE task_id = $1 AND key = $2 ORDER BY created_at DESC LIMIT 1
       ) RETURNING ${DECISION_COLUMNS}`,
      [input.taskId, input.key, input.chosenKey, input.customAnswer, input.answeredBy],
    );
    if (!row) throw new NotFoundError('ReviewDecision', `${input.taskId}/${input.key}`);
    return camelize<ReviewDecisionRecord>(row);
  }

  /** Every decision on this task that nobody has answered yet. */
  async listOpenForTask(taskId: string): Promise<ReviewDecisionRecord[]> {
    return camelizeAll<ReviewDecisionRecord>(
      await this.db.query(
        `SELECT ${DECISION_COLUMNS} FROM review_decisions WHERE task_id = $1 AND status = 'OPEN'
          ORDER BY blocking DESC, created_at ASC`,
        [taskId],
      ),
    );
  }

  async answer(input: {
    reviewVersionId: string;
    key: string;
    chosenKey: string;
    customAnswer: string | null;
    answeredBy: string;
  }): Promise<ReviewDecisionRecord> {
    const row = await this.db.queryOne(
      `UPDATE review_decisions SET status = 'ANSWERED', chosen_key = $3, custom_answer = $4,
         answered_by = $5, answered_at = now()
       WHERE review_version_id = $1 AND key = $2 RETURNING ${DECISION_COLUMNS}`,
      [input.reviewVersionId, input.key, input.chosenKey, input.customAnswer, input.answeredBy],
    );
    if (!row) throw new NotFoundError('ReviewDecision', `${input.reviewVersionId}/${input.key}`);
    return camelize<ReviewDecisionRecord>(row);
  }

  /** How many blocking decisions on this version are still unanswered. */
  async openBlockingCount(reviewVersionId: string): Promise<number> {
    const row = await this.db.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM review_decisions
        WHERE review_version_id = $1 AND blocking AND status = 'OPEN'`,
      [reviewVersionId],
    );
    return Number(row?.count ?? 0);
  }

  /**
   * Blocking decisions still open across every task, for the cockpit's list of
   * what is waiting on a person. Only the current version of each review counts:
   * a superseded version's questions were asked about a plan that no longer
   * exists.
   */
  async openBlockingByTask(): Promise<Map<string, number>> {
    const rows = await this.db.query<{ task_id: string; count: string }>(
      `SELECT d.task_id, COUNT(*)::text AS count
         FROM review_decisions d
         JOIN review_versions v ON v.id = d.review_version_id
         JOIN reviews r ON r.id = v.review_id AND r.current_version = v.version
        WHERE d.blocking AND d.status = 'OPEN'
        GROUP BY d.task_id`,
    );
    return new Map(rows.map((row) => [row.task_id, Number(row.count)]));
  }
}
