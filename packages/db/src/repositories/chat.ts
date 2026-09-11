import { newId, NotFoundError } from '@ai-engine/shared';
import type { ChatMessage, ChatSession } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const SESSION_COLUMNS = `id, project_id, title, engine_session_id, permission_mode, archived_at,
  created_at, updated_at`;
const MESSAGE_COLUMNS = `id, session_id, sequence, role, content, status, tool_calls, run_id, error,
  created_at, updated_at`;

/**
 * The chat window's transcript.
 *
 * The engine keeps its own session store, but it is not ours to read and it does
 * not survive being asked about from another process, so the cockpit needs its
 * own copy. The engine's session id is kept beside it, which is what makes every
 * turn a continuation rather than a new conversation about the same project.
 */
export class ChatRepository {
  constructor(private readonly db: Queryable) {}

  async createSession(input: { projectId: string; title?: string; permissionMode: string }): Promise<ChatSession> {
    const row = await this.db.queryOne(
      `INSERT INTO chat_sessions (id, project_id, title, permission_mode) VALUES ($1, $2, $3, $4)
       RETURNING ${SESSION_COLUMNS}`,
      [newId(), input.projectId, input.title ?? 'New chat', input.permissionMode],
    );
    return camelize<ChatSession>(row!);
  }

  async getSession(id: string): Promise<ChatSession> {
    const row = await this.db.queryOne(`SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = $1`, [id]);
    if (!row) throw new NotFoundError('ChatSession', id);
    return camelize<ChatSession>(row);
  }

  async listSessions(projectId: string, limit = 50): Promise<ChatSession[]> {
    return camelizeAll<ChatSession>(
      await this.db.query(
        `SELECT ${SESSION_COLUMNS} FROM chat_sessions
          WHERE project_id = $1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT $2`,
        [projectId, limit],
      ),
    );
  }

  async updateSession(
    id: string,
    patch: { title?: string; engineSessionId?: string | null; permissionMode?: string },
  ): Promise<ChatSession> {
    const row = await this.db.queryOne(
      `UPDATE chat_sessions SET
         title = COALESCE($2, title),
         engine_session_id = COALESCE($3, engine_session_id),
         permission_mode = COALESCE($4, permission_mode),
         updated_at = now()
       WHERE id = $1 RETURNING ${SESSION_COLUMNS}`,
      [id, patch.title ?? null, patch.engineSessionId ?? null, patch.permissionMode ?? null],
    );
    if (!row) throw new NotFoundError('ChatSession', id);
    return camelize<ChatSession>(row);
  }

  async archiveSession(id: string): Promise<void> {
    await this.db.query('UPDATE chat_sessions SET archived_at = now() WHERE id = $1', [id]);
  }

  /**
   * Appends a message. The sequence comes from the table rather than the caller,
   * so two turns racing cannot both claim the same position.
   */
  async appendMessage(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    content?: string;
    status?: ChatMessage['status'];
  }): Promise<ChatMessage> {
    const row = await this.db.queryOne(
      `INSERT INTO chat_messages (id, session_id, sequence, role, content, status)
       VALUES ($1, $2,
               (SELECT COALESCE(MAX(sequence), 0) + 1 FROM chat_messages WHERE session_id = $2),
               $3, $4, $5)
       RETURNING ${MESSAGE_COLUMNS}`,
      [newId(), input.sessionId, input.role, input.content ?? '', input.status ?? 'COMPLETE'],
    );
    return camelize<ChatMessage>(row!);
  }

  /** Written repeatedly while the answer streams, so it is readable as it lands. */
  async updateMessage(
    id: string,
    patch: {
      content?: string;
      status?: ChatMessage['status'];
      toolCalls?: { name: string; input: Record<string, unknown> }[];
      runId?: string | null;
      error?: string | null;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE chat_messages SET
         content = COALESCE($2, content),
         status = COALESCE($3, status),
         tool_calls = COALESCE($4::jsonb, tool_calls),
         run_id = COALESCE($5, run_id),
         error = $6,
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        patch.content ?? null,
        patch.status ?? null,
        patch.toolCalls ? JSON.stringify(patch.toolCalls) : null,
        patch.runId ?? null,
        patch.error ?? null,
      ],
    );
  }

  async listMessages(sessionId: string, limit = 500): Promise<ChatMessage[]> {
    return camelizeAll<ChatMessage>(
      await this.db.query(
        `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE session_id = $1 ORDER BY sequence ASC LIMIT $2`,
        [sessionId, limit],
      ),
    );
  }

  async getMessage(id: string): Promise<ChatMessage> {
    const row = await this.db.queryOne(`SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE id = $1`, [id]);
    if (!row) throw new NotFoundError('ChatMessage', id);
    return camelize<ChatMessage>(row);
  }

  /**
   * Whether this session already has a turn in flight.
   *
   * Two turns at once would both resume the same engine session and the second
   * would either be refused or interleave with the first. One at a time per
   * session is the rule; different sessions run freely.
   */
  async hasPendingTurn(sessionId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM chat_messages
        WHERE session_id = $1 AND role = 'assistant' AND status IN ('PENDING', 'STREAMING')`,
      [sessionId],
    );
    return Number(row?.count ?? 0) > 0;
  }
}
