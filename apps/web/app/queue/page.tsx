'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type QueueEntry, type QueueView } from '../../lib/api';
import { Alert, Button, Card, Empty, ErrorText, StateBadge, Tile } from '../../components/ui';
import { formatDuration, relativeAge } from '../../lib/format';
import { jobLabel } from '../../lib/labels';

/**
 * The queue, which is one queue for every project.
 *
 * What is in it are steps, not stories. A story is a sequence of steps with human
 * gates between them, and if the story held the slot then one review waiting for
 * an answer would block every other project. So a slot is held only while an
 * agent is actually running, and a story waiting for a person holds nothing —
 * which is why the things waiting on you are a separate list below rather than
 * rows in this one.
 */
export default function QueuePage() {
  const router = useRouter();
  const [view, setView] = useState<QueueView | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<QueueView>('/api/queue');
      setView(result);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  // The drag order is local until it is saved, but the poll keeps arriving. The
  // local order is only trusted while a drag is in progress; otherwise the server
  // is the truth, which is what stops a half-finished drag from sticking.
  const pending = view?.entries.filter((entry) => entry.status === 'PENDING') ?? [];
  const running = view?.entries.filter((entry) => entry.status === 'RUNNING') ?? [];
  const ordered = dragging
    ? order.map((id) => pending.find((entry) => entry.id === id)).filter((entry): entry is QueueEntry => Boolean(entry))
    : pending;

  function startDrag(id: string) {
    setDragging(id);
    setOrder(pending.map((entry) => entry.id));
  }

  function dragOver(id: string) {
    if (!dragging || id === dragging) return;
    setOver(id);
    setOrder((current) => {
      const from = current.indexOf(dragging);
      const to = current.indexOf(id);
      if (from === -1 || to === -1) return current;
      const next = [...current];
      next.splice(from, 1);
      next.splice(to, 0, dragging);
      return next;
    });
  }

  async function commitDrag() {
    const ids = order;
    setDragging(null);
    setOver(null);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await api.post('/api/queue/reorder', { ids });
      await load();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string) {
    setBusy(true);
    try {
      await api.post(path);
      await load();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  if (!view) return <div className="page">{error ? <ErrorText>{error}</ErrorText> : 'Reading the queue.'}</div>;

  const paused = view.policy.paused;

  return (
    <div className="page enter">
      <div className="row-between">
        <div className="grow">
          <h1 className="display">Queue</h1>
          <p className="standfirst">
            One queue for every project. What is in it are steps rather than whole stories, so a story waiting for your
            answer holds nothing up, and the next thing to start is whatever is at the top here.
          </p>
        </div>
        <div className="row">
          {paused ? (
            <Button onClick={() => void act('/api/queue/resume')} disabled={busy}>
              Start the queue
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void act('/api/queue/pause')} disabled={busy}>
              Pause the queue
            </Button>
          )}
        </div>
      </div>

      {error ? <ErrorText>{error}</ErrorText> : null}

      <div className="tiles">
        <Tile value={`${view.policy.runningSlots}/${view.policy.concurrency}`} label="Slots in use" />
        <Tile value={pending.length} label="Waiting to start" tone="caution" />
        <Tile value={view.waiting.length} label="Waiting for you" tone={view.waiting.length > 0 ? 'attention' : undefined} />
        <Tile value={paused ? 'Paused' : 'Live'} label="Queue" tone={paused ? 'attention' : 'positive'} />
      </div>

      {paused ? (
        <Alert tone="caution" title="Paused">
          Nothing new starts while the queue is paused. Anything already running is finishing rather than being killed,
          and the order below is kept exactly as it is.
        </Alert>
      ) : null}

      <section className="stack">
        <h2 className="subhead">Running now</h2>
        {running.length === 0 ? (
          <Empty>No step is running.</Empty>
        ) : (
          <div className="list">
            {running.map((entry) => (
              <div key={entry.id} className="list-row accent-running">
                <div className="grow">
                  <div className="list-title">{jobLabel(entry.jobType)}</div>
                  <div className="meta" style={{ marginTop: 9 }}>
                    {entry.projectName ?? '—'} · {entry.storyTitle ?? 'no story'} · running for{' '}
                    {formatDuration(entry.lockedAt ? Date.now() - Date.parse(entry.lockedAt) : null)}
                  </div>
                </div>
                {entry.taskId ? (
                  <Button size="sm" variant="secondary" onClick={() => router.push(`/tasks/${entry.taskId}`)}>
                    Open the story
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="stack">
        <div className="row-between">
          <h2 className="subhead">Waiting to start</h2>
          <span className="meta">Drag to reorder</span>
        </div>
        {ordered.length === 0 ? (
          <Empty>The queue is empty.</Empty>
        ) : (
          <div className="list">
            {ordered.map((entry) => (
              <div
                key={entry.id}
                className={`list-row drag-row ${dragging === entry.id ? 'dragging' : ''} ${
                  over === entry.id ? 'drop-target' : ''
                } ${entry.heldAt ? 'accent-critical' : 'accent-waiting'}`}
                draggable={!busy}
                onDragStart={() => startDrag(entry.id)}
                onDragEnter={() => dragOver(entry.id)}
                onDragOver={(event) => event.preventDefault()}
                onDragEnd={() => void commitDrag()}
              >
                <span className="drag-handle" aria-hidden>
                  ::
                </span>
                <div className="grow">
                  <div className="list-title">{jobLabel(entry.jobType)}</div>
                  <div className="meta" style={{ marginTop: 9 }}>
                    {entry.projectName ?? '—'} · {entry.storyTitle ?? 'no story'} · queued {relativeAge(entry.createdAt)}
                    {entry.attempt > 0 ? ` · attempt ${entry.attempt} of ${entry.maxAttempts}` : ''}
                    {entry.consumesSlot ? '' : ' · does not take a slot'}
                  </div>
                  {entry.lastError ? (
                    <div className="body-sm" style={{ color: 'var(--ink-critical)' }}>
                      {entry.lastError.split('\n')[0]}
                    </div>
                  ) : null}
                </div>
                <div className="row">
                  {entry.heldAt ? (
                    <>
                      <span className="badge critical">Held</span>
                      <Button size="sm" variant="secondary" onClick={() => void act(`/api/queue/${entry.id}/release`)} disabled={busy}>
                        Release
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => void act(`/api/queue/${entry.id}/hold`)} disabled={busy}>
                      Hold
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void act(`/api/queue/${entry.id}/cancel`)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="stack">
        <div className="row-between">
          <h2 className="subhead">Waiting for you</h2>
          <span className="meta">Not in the queue, and holding nothing up</span>
        </div>
        {view.waiting.length === 0 ? (
          <Empty>Nothing is waiting on a person.</Empty>
        ) : (
          <div className="list">
            {view.waiting.map((item) => (
              <div
                key={item.taskId}
                className="list-row clickable accent-waiting"
                onClick={() => router.push(`/tasks/${item.taskId}`)}
              >
                <div className="grow">
                  <div className="list-title">{item.storyTitle}</div>
                  <div className="meta" style={{ marginTop: 9 }}>
                    {item.projectName} · waiting {relativeAge(item.since)}
                    {item.openDecisions > 0 ? ` · ${item.openDecisions} decision(s) to answer` : ''}
                  </div>
                </div>
                <StateBadge state={item.state} />
              </div>
            ))}
          </div>
        )}
      </section>

      <Card tone="plain">
        <span className="meta">How this queue behaves</span>
        <p className="body-sm">
          A slot is taken only while an agent session or a test run is actually happening. When one finishes, the slot
          goes to whatever is at the top of the list above, whether that is another review or something else entirely.
          Answering a question or approving a plan never waits for a slot, and neither does the chat window.
        </p>
        <p className="body-sm">
          Raising the number of slots does not make one story finish sooner. It lets several stories make progress at
          once, against one account limit and one machine.
        </p>
      </Card>
    </div>
  );
}
