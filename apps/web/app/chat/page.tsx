'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ChatMessage, type ChatSession, type Project } from '../../lib/api';
import { useProjects } from '../../components/shell';
import { Alert, Badge, Button, Card, Empty, ErrorText, Field } from '../../components/ui';
import { DraftTextarea } from '../../components/draft-textarea';
import { clearDraft, readDraft } from '../../lib/draft-field';
import { relativeAge } from '../../lib/format';

interface SessionView {
  session: ChatSession;
  project: Project;
  messages: ChatMessage[];
  pending: boolean;
}

const MODE_LABELS: Record<string, string> = {
  dontAsk: 'Read only',
  acceptEdits: 'Can edit files',
  bypassPermissions: 'Everything',
};

/**
 * The chat window.
 *
 * This is the engine in the project directory, driven turn by turn by a person:
 * the same thing as opening a terminal there, with the transcript kept so it
 * survives a restart. It is deliberately the widest surface in the cockpit, and
 * the header says what it is allowed to do rather than leaving that to be
 * discovered.
 */
export default function ChatPage() {
  const { project } = useProjects();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadSessions = useCallback(async () => {
    if (!project) return;
    try {
      const result = await api.get<{ sessions: ChatSession[] }>(`/api/chat/sessions?projectId=${project.id}`);
      setSessions(result.sessions);
      setActiveId((current) => current ?? result.sessions[0]?.id ?? null);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [project]);

  useEffect(() => {
    setActiveId(null);
    setView(null);
    void loadSessions();
  }, [loadSessions]);

  // Polled rather than streamed to the browser: the worker writes the answer into
  // the row as it arrives, so a poll is enough to read it as it is written and
  // there is no socket to lose.
  useEffect(() => {
    if (!activeId) return undefined;
    async function load() {
      try {
        setView(await api.get<SessionView>(`/api/chat/sessions/${activeId}`));
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 1200);
    return () => clearInterval(timer);
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [view?.messages.length]);

  async function startSession() {
    if (!project) return;
    setBusy(true);
    try {
      const result = await api.post<{ session: ChatSession }>('/api/chat/sessions', { projectId: project.id });
      await loadSessions();
      setActiveId(result.session.id);
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const text = readDraft(inputRef.current).trim();
    if (!text || !activeId) return;
    setBusy(true);
    try {
      await api.post(`/api/chat/sessions/${activeId}/messages`, { text });
      clearDraft(inputRef.current);
      setError(null);
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  async function archive(sessionId: string) {
    await api.delete(`/api/chat/sessions/${sessionId}`);
    setActiveId(null);
    await loadSessions();
  }

  if (!project) return <div className="page">Add a project first.</div>;

  return (
    <div className="page enter">
      <div className="row-between">
        <div className="grow">
          <h1 className="display">Chat</h1>
          <p className="standfirst">
            The engine, in {project.name}, one turn at a time. The same thing as opening a terminal in that directory,
            except the conversation is kept here and survives a restart.
          </p>
        </div>
        <Button onClick={() => void startSession()} disabled={busy}>
          New chat
        </Button>
      </div>

      {error ? <ErrorText>{error}</ErrorText> : null}

      {view && view.session.permissionMode !== 'dontAsk' ? (
        <Alert tone="caution" title={`This chat can change files in ${project.name}`}>
          It is set to “{MODE_LABELS[view.session.permissionMode] ?? view.session.permissionMode}”, and it is working in
          your actual checkout, on whatever branch it is on. There is no terminal for it to ask in, so it does not ask.
          Change this under Settings.
        </Alert>
      ) : null}

      <div className="chat">
        <div className="chat-sessions">
          <span className="meta">Conversations</span>
          {sessions.length === 0 ? (
            <Empty>No chat yet.</Empty>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                className={`chat-session ${session.id === activeId ? 'active' : ''}`}
                onClick={() => setActiveId(session.id)}
              >
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{session.title}</div>
                <div className="meta" style={{ marginTop: 6 }}>
                  {relativeAge(session.updatedAt)}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="chat-thread">
          {!activeId ? (
            <Card>
              <span className="meta">Nothing open</span>
              <p className="body-sm">
                Start a chat to ask about this project, or to have something done in it directly rather than through a
                story. A story is the right tool when you want a plan, a review and a record; this is the right tool when
                you want to look at something.
              </p>
            </Card>
          ) : !view ? (
            <Empty>Reading the conversation.</Empty>
          ) : (
            <>
              {view.messages.length === 0 ? (
                <Empty>Nothing has been said yet.</Empty>
              ) : (
                view.messages.map((message) => (
                  <div key={message.id} className={`turn ${message.role}`}>
                    <div className="row-between">
                      <span className="meta">{message.role === 'user' ? 'You' : 'Story Builder'}</span>
                      <span className="row">
                        {message.status === 'STREAMING' ? <Badge tone="waiting">writing</Badge> : null}
                        {message.status === 'PENDING' ? <Badge tone="waiting">queued</Badge> : null}
                        {message.status === 'FAILED' ? <Badge tone="critical">failed</Badge> : null}
                        <span className="meta">{relativeAge(message.createdAt)}</span>
                      </span>
                    </div>
                    {message.content ? (
                      <div className="turn-body">{message.content}</div>
                    ) : message.status === 'PENDING' || message.status === 'STREAMING' ? (
                      <div className="body-sm">Thinking…</div>
                    ) : null}
                    {message.toolCalls.length > 0 ? (
                      <div className="turn-tools">
                        {message.toolCalls.slice(0, 16).map((call, index) => (
                          <span className="tool-chip" key={`${call.name}-${index}`}>
                            {call.name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {message.error ? <ErrorText>{message.error}</ErrorText> : null}
                  </div>
                ))
              )}
              <div ref={bottomRef} />

              <Card>
                <Field label={view.pending ? 'Still answering' : 'Your turn'}>
                  <DraftTextarea
                    textareaRef={inputRef}
                    rows={4}
                    placeholder="Where does the email change get written today?"
                    onSubmit={() => void send()}
                  />
                </Field>
                <div className="row">
                  <Button onClick={() => void send()} disabled={busy || view.pending}>
                    {view.pending ? 'Waiting for the answer' : 'Send'}
                  </Button>
                  <span className="meta">Enter sends · Shift and Enter makes a new line</span>
                  <Button variant="ghost" onClick={() => void archive(view.session.id)} disabled={busy}>
                    Archive this chat
                  </Button>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
