import { newId, NotFoundError } from '@ai-engine/shared';
import type { IdeaQuestion, IdeaQuestionOption, IdeaSession, IdeaSessionStatus, StoryDraft } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const SESSION_COLUMNS = 'id, project_id, idea, status, understanding, round, error, created_at, updated_at';
const QUESTION_COLUMNS = `id, session_id, round, sequence, question, rationale, options, chosen_key,
  custom_answer, answered_at, created_at`;
const DRAFT_COLUMNS = `id, project_id, session_id, title, body, rationale, sequence, status, task_id,
  created_at, updated_at`;

/**
 * Building a story before running it.
 *
 * An idea arrives as a paragraph. It may be several stories, or one story
 * described too thinly to act on, and the only way to tell is to ask. This holds
 * that conversation: the idea, what the agent understood, the questions it asked
 * with the answers given, and the drafts it ended up with.
 *
 * The drafts are the thing a person keeps. A session is the record of how they
 * were arrived at, which is worth keeping for the same reason the review
 * versions are: it is where a misunderstanding becomes visible.
 */
export class IdeaRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: { projectId: string; idea: string }): Promise<IdeaSession> {
    const row = await this.db.queryOne(
      `INSERT INTO idea_sessions (id, project_id, idea) VALUES ($1, $2, $3) RETURNING ${SESSION_COLUMNS}`,
      [newId(), input.projectId, input.idea],
    );
    return camelize<IdeaSession>(row!);
  }

  async getById(id: string): Promise<IdeaSession> {
    const row = await this.db.queryOne(`SELECT ${SESSION_COLUMNS} FROM idea_sessions WHERE id = $1`, [id]);
    if (!row) throw new NotFoundError('IdeaSession', id);
    return camelize<IdeaSession>(row);
  }

  async listByProject(projectId: string, limit = 50): Promise<IdeaSession[]> {
    return camelizeAll<IdeaSession>(
      await this.db.query(
        `SELECT ${SESSION_COLUMNS} FROM idea_sessions
          WHERE project_id = $1 AND status <> 'DISCARDED'
          ORDER BY created_at DESC LIMIT $2`,
        [projectId, limit],
      ),
    );
  }

  async update(
    id: string,
    patch: { status?: IdeaSessionStatus; understanding?: string | null; round?: number; error?: string | null },
  ): Promise<IdeaSession> {
    const row = await this.db.queryOne(
      `UPDATE idea_sessions SET
         status = COALESCE($2, status),
         understanding = COALESCE($3, understanding),
         round = COALESCE($4, round),
         error = $5,
         updated_at = now()
       WHERE id = $1 RETURNING ${SESSION_COLUMNS}`,
      [id, patch.status ?? null, patch.understanding ?? null, patch.round ?? null, patch.error ?? null],
    );
    if (!row) throw new NotFoundError('IdeaSession', id);
    return camelize<IdeaSession>(row);
  }

  async discard(id: string): Promise<void> {
    await this.db.query(`UPDATE idea_sessions SET status = 'DISCARDED', updated_at = now() WHERE id = $1`, [id]);
  }

  /**
   * Replaces the questions for one round.
   *
   * A round is asked and answered as a unit, and a re-run of the same round means
   * the agent is asking again rather than adding to what it asked. Deleting the
   * round first keeps the sequence numbers meaningful instead of leaving two
   * generations of question interleaved.
   */
  async setQuestions(
    sessionId: string,
    round: number,
    questions: { question: string; rationale: string; options: IdeaQuestionOption[] }[],
  ): Promise<IdeaQuestion[]> {
    await this.db.query('DELETE FROM idea_questions WHERE session_id = $1 AND round = $2 AND answered_at IS NULL', [
      sessionId,
      round,
    ]);
    const created: IdeaQuestion[] = [];
    for (const [index, question] of questions.entries()) {
      const row = await this.db.queryOne(
        `INSERT INTO idea_questions (id, session_id, round, sequence, question, rationale, options)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (session_id, round, sequence) DO UPDATE
           SET question = $5, rationale = $6, options = $7::jsonb
         RETURNING ${QUESTION_COLUMNS}`,
        [newId(), sessionId, round, index + 1, question.question, question.rationale, JSON.stringify(question.options)],
      );
      created.push(camelize<IdeaQuestion>(row!));
    }
    return created;
  }

  async listQuestions(sessionId: string): Promise<IdeaQuestion[]> {
    return camelizeAll<IdeaQuestion>(
      await this.db.query(
        `SELECT ${QUESTION_COLUMNS} FROM idea_questions WHERE session_id = $1 ORDER BY round ASC, sequence ASC`,
        [sessionId],
      ),
    );
  }

  async answerQuestion(
    questionId: string,
    answer: { chosenKey: string; customAnswer: string | null },
  ): Promise<IdeaQuestion> {
    const row = await this.db.queryOne(
      `UPDATE idea_questions SET chosen_key = $2, custom_answer = $3, answered_at = now()
       WHERE id = $1 RETURNING ${QUESTION_COLUMNS}`,
      [questionId, answer.chosenKey, answer.customAnswer],
    );
    if (!row) throw new NotFoundError('IdeaQuestion', questionId);
    return camelize<IdeaQuestion>(row);
  }

  async unansweredCount(sessionId: string): Promise<number> {
    const row = await this.db.queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM idea_questions WHERE session_id = $1 AND answered_at IS NULL',
      [sessionId],
    );
    return Number(row?.count ?? 0);
  }

  /** Replaces the drafts a session produced, since a new round supersedes them. */
  async replaceDrafts(
    sessionId: string,
    projectId: string,
    drafts: { title: string; body: string; rationale: string }[],
  ): Promise<StoryDraft[]> {
    await this.db.query(`DELETE FROM story_drafts WHERE session_id = $1 AND status = 'DRAFT'`, [sessionId]);
    const created: StoryDraft[] = [];
    for (const [index, draft] of drafts.entries()) {
      const row = await this.db.queryOne(
        `INSERT INTO story_drafts (id, project_id, session_id, title, body, rationale, sequence)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${DRAFT_COLUMNS}`,
        [newId(), projectId, sessionId, draft.title, draft.body, draft.rationale, index + 1],
      );
      created.push(camelize<StoryDraft>(row!));
    }
    return created;
  }

  async createDraft(input: {
    projectId: string;
    title: string;
    body: string;
    rationale?: string;
  }): Promise<StoryDraft> {
    const row = await this.db.queryOne(
      `INSERT INTO story_drafts (id, project_id, title, body, rationale) VALUES ($1, $2, $3, $4, $5)
       RETURNING ${DRAFT_COLUMNS}`,
      [newId(), input.projectId, input.title, input.body, input.rationale ?? ''],
    );
    return camelize<StoryDraft>(row!);
  }

  async listDrafts(projectId: string): Promise<StoryDraft[]> {
    return camelizeAll<StoryDraft>(
      await this.db.query(
        `SELECT ${DRAFT_COLUMNS} FROM story_drafts WHERE project_id = $1 AND status = 'DRAFT'
          ORDER BY created_at DESC, sequence ASC`,
        [projectId],
      ),
    );
  }

  async listDraftsForSession(sessionId: string): Promise<StoryDraft[]> {
    return camelizeAll<StoryDraft>(
      await this.db.query(
        `SELECT ${DRAFT_COLUMNS} FROM story_drafts WHERE session_id = $1 ORDER BY sequence ASC`,
        [sessionId],
      ),
    );
  }

  async getDraft(id: string): Promise<StoryDraft> {
    const row = await this.db.queryOne(`SELECT ${DRAFT_COLUMNS} FROM story_drafts WHERE id = $1`, [id]);
    if (!row) throw new NotFoundError('StoryDraft', id);
    return camelize<StoryDraft>(row);
  }

  async updateDraft(id: string, patch: { title?: string; body?: string }): Promise<StoryDraft> {
    const row = await this.db.queryOne(
      `UPDATE story_drafts SET title = COALESCE($2, title), body = COALESCE($3, body), updated_at = now()
       WHERE id = $1 RETURNING ${DRAFT_COLUMNS}`,
      [id, patch.title ?? null, patch.body ?? null],
    );
    if (!row) throw new NotFoundError('StoryDraft', id);
    return camelize<StoryDraft>(row);
  }

  async markDraftLaunched(id: string, taskId: string): Promise<void> {
    await this.db.query(
      `UPDATE story_drafts SET status = 'LAUNCHED', task_id = $2, updated_at = now() WHERE id = $1`,
      [id, taskId],
    );
  }

  async discardDraft(id: string): Promise<void> {
    await this.db.query(`UPDATE story_drafts SET status = 'DISCARDED', updated_at = now() WHERE id = $1`, [id]);
  }
}
