'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, type IdeaQuestion, type IdeaSession, type StoryDraft, type Task } from '../../../lib/api';
import { Alert, Bar, Button, Card, Empty, ErrorText, Field } from '../../../components/ui';
import { DraftTextarea } from '../../../components/draft-textarea';
import { clearDraft, readDraft } from '../../../lib/draft-field';
import { relativeAge } from '../../../lib/format';

interface SessionView {
  session: IdeaSession;
  currentRound: IdeaQuestion[];
  history: IdeaQuestion[];
  drafts: StoryDraft[];
}

/**
 * Shaping one idea into stories.
 *
 * The questions arrive one at a time rather than as a form. A form invites
 * skimming and answering the easy ones; one question with two or three real
 * options, each with its consequence spelled out, is a decision a person
 * actually makes.
 */
export default function IdeaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const sessionId = params.id;
  const [view, setView] = useState<SessionView | null>(null);
  const [index, setIndex] = useState(0);
  const [writingOwn, setWritingOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<SessionView>(`/api/ideas/${sessionId}`);
      setView(result);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  // Always sitting on the first question still unanswered, so answering one
  // moves to the next without anyone clicking through.
  useEffect(() => {
    if (!view) return;
    const next = view.currentRound.findIndex((question) => !question.answeredAt);
    setIndex(next === -1 ? Math.max(0, view.currentRound.length - 1) : next);
  }, [view]);

  async function answer(question: IdeaQuestion, chosenKey: string, customAnswer?: string) {
    setBusy(true);
    try {
      await api.post(`/api/ideas/${sessionId}/answers`, { questionId: question.id, chosenKey, customAnswer });
      setWritingOwn(false);
      clearDraft(ownRef.current);
      await load();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  async function launch(draft: StoryDraft) {
    setBusy(true);
    try {
      const result = await api.post<{ task: Task }>(`/api/drafts/${draft.id}/launch`);
      router.push(`/tasks/${result.task.id}`);
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
      setBusy(false);
    }
  }

  if (!view) return <div className="page">{error ? <ErrorText>{error}</ErrorText> : 'Reading the idea.'}</div>;

  const { session, currentRound, history, drafts } = view;
  const answered = currentRound.filter((question) => question.answeredAt).length;
  const question = currentRound[index];
  const thinking = session.status === 'QUEUED' || session.status === 'THINKING';

  return (
    <div className="page enter">
      <div>
        <span className="meta" onClick={() => router.push('/stories')} style={{ cursor: 'pointer', color: 'var(--text-accent)' }}>
          ← All stories
        </span>
        <h1 className="display" style={{ marginTop: 18 }}>
          Describe an idea
        </h1>
      </div>

      {error ? <ErrorText>{error}</ErrorText> : null}

      <Card>
        <span className="meta">What you wrote · {relativeAge(session.createdAt)}</span>
        <div className="prose">{session.idea}</div>
      </Card>

      {session.understanding ? (
        <Card tone="olive">
          <span className="meta" style={{ color: 'rgba(242,229,200,0.82)' }}>
            What it understood
          </span>
          <div className="prose">{session.understanding}</div>
          <span className="body-sm" style={{ color: 'rgba(242,229,200,0.82)' }}>
            If this is not your idea, say so in an answer below or start again. It is cheaper to correct here than in a
            review.
          </span>
        </Card>
      ) : null}

      {session.status === 'FAILED' ? (
        <Alert tone="critical" title="This did not finish">
          {session.error ?? 'No reason was recorded.'}
        </Alert>
      ) : null}

      {thinking ? (
        <Card>
          <span className="meta">Reading the project</span>
          <p className="body-sm">
            It is looking at the code this idea touches, so its questions are about your repository rather than about
            software in general. This is the cheap step; it takes a minute or two.
          </p>
        </Card>
      ) : null}

      {session.status === 'ASKING' && question ? (
        <section className="stack">
          <div className="row-between">
            <h2 className="subhead">
              Question {index + 1} of {currentRound.length}
            </h2>
            <span className="meta">
              {answered} answered · round {session.round}
            </span>
          </div>
          <Bar percent={(answered / Math.max(1, currentRound.length)) * 100} />

          <Card>
            <span className="meta">Why this is being asked</span>
            <span className="body-sm">{question.rationale}</span>
            <div className="accent-rule" />
            <div className="prose" style={{ fontSize: 19 }}>
              {question.question}
            </div>

            <div className="choices" style={{ marginTop: 8 }}>
              {question.options.map((option) => (
                <button
                  key={option.key}
                  className={`choice ${question.chosenKey === option.key ? 'selected' : ''}`}
                  onClick={() => void answer(question, option.key)}
                  disabled={busy || Boolean(question.answeredAt)}
                >
                  <span className="choice-label">{option.label}</span>
                  {option.detail ? <span className="choice-detail">{option.detail}</span> : null}
                </button>
              ))}

              {writingOwn ? (
                <Card tone="plain">
                  <Field label="Your answer">
                    <DraftTextarea
                      textareaRef={ownRef}
                      rows={4}
                      placeholder="Keep the old address able to cancel for seven days."
                    />
                  </Field>
                  <div className="row">
                    <Button
                      size="sm"
                      onClick={() => void answer(question, 'custom', readDraft(ownRef.current))}
                      disabled={busy}
                    >
                      Use this answer
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setWritingOwn(false)}>
                      Cancel
                    </Button>
                  </div>
                </Card>
              ) : (
                <button
                  className="choice"
                  onClick={() => setWritingOwn(true)}
                  disabled={busy || Boolean(question.answeredAt)}
                >
                  <span className="choice-label">Something else</span>
                  <span className="choice-detail">Answer in your own words.</span>
                </button>
              )}
            </div>
          </Card>

          {currentRound.length > 1 ? (
            <div className="row">
              {currentRound.map((entry, position) => (
                <button
                  key={entry.id}
                  className={`filter ${position === index ? 'active' : ''}`}
                  onClick={() => setIndex(position)}
                >
                  {position + 1}
                  {entry.answeredAt ? ' ✓' : ''}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {session.status === 'READY' ? (
        <section className="stack">
          <div className="row-between">
            <h2 className="subhead">{drafts.length === 1 ? 'One story' : `${drafts.length} stories`}</h2>
            <span className="meta">Edit anything before you launch it</span>
          </div>
          {drafts.length === 0 ? (
            <Empty>It produced no story. Start again with more detail.</Empty>
          ) : (
            <div className="stack">
              {drafts.map((draft) => (
                <Card key={draft.id}>
                  <span className="meta">
                    Part {draft.sequence} of {drafts.length}
                    {draft.status === 'LAUNCHED' ? ' · launched' : ''}
                  </span>
                  <div className="accent-rule" />
                  <h3 className="subhead">{draft.title}</h3>
                  <div className="prose">{draft.body}</div>
                  {draft.rationale ? (
                    <span className="body-sm">Why this is its own story: {draft.rationale}</span>
                  ) : null}
                  <div className="row">
                    {draft.status === 'LAUNCHED' && draft.taskId ? (
                      <Button size="sm" variant="secondary" onClick={() => router.push(`/tasks/${draft.taskId}`)}>
                        Open it
                      </Button>
                    ) : (
                      <>
                        <Button size="sm" onClick={() => void launch(draft)} disabled={busy}>
                          Launch this one
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => router.push('/stories')}>
                          Keep it for later
                        </Button>
                      </>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {history.length > 0 ? (
        <section className="stack">
          <h2 className="subhead">Already answered</h2>
          <div className="table-scroll">
            <table>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id}>
                    <td style={{ width: '50%' }}>{entry.question}</td>
                    <td>
                      {entry.chosenKey === 'custom'
                        ? entry.customAnswer
                        : (entry.options.find((option) => option.key === entry.chosenKey)?.label ?? '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
