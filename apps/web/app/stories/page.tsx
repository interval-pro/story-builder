'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type IdeaSession, type StoryDraft, type Task } from '../../lib/api';
import { useProjects } from '../../components/shell';
import { Button, Card, Dialog, Empty, ErrorText, Field, StateBadge, Tile } from '../../components/ui';
import { DraftTextarea } from '../../components/draft-textarea';
import { clearDraft, readDraft } from '../../lib/draft-field';
import { relativeAge } from '../../lib/format';
import { explainState } from '../../lib/labels';

type Filter = 'all' | 'waiting' | 'running' | 'done';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'waiting', label: 'Waiting for you' },
  { key: 'running', label: 'Running' },
  { key: 'done', label: 'Finished' },
];

function matches(filter: Filter, state: string): boolean {
  const tone = explainState(state).tone;
  if (filter === 'all') return true;
  if (filter === 'waiting') return tone === 'waiting' || tone === 'critical';
  if (filter === 'running') return tone === 'running' || tone === 'caution';
  return tone === 'done';
}

/**
 * Stories: the ones running, and the drafts that are not running yet.
 *
 * A draft is the step this system was missing. An idea went straight into the
 * pipeline, which meant an idea that was really four stories became one enormous
 * review, and an idea described in one line sent the research pass off to guess.
 */
export default function StoriesPage() {
  const { project } = useProjects();
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafts, setDrafts] = useState<StoryDraft[]>([]);
  const [sessions, setSessions] = useState<IdeaSession[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<StoryDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ideaRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Read off the location rather than through useSearchParams: that hook makes
  // the whole page opt out of prerendering unless it is wrapped in a Suspense
  // boundary, and a boundary around the entire screen to read one flag is a
  // worse trade than reading it here.
  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('compose') === '1') {
      setComposing(true);
    }
  }, []);

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const [taskResult, draftResult, sessionResult] = await Promise.all([
        api.get<{ tasks: Task[] }>(`/api/tasks?projectId=${project.id}`),
        api.get<{ drafts: StoryDraft[] }>(`/api/drafts?projectId=${project.id}`),
        api.get<{ sessions: IdeaSession[] }>(`/api/ideas?projectId=${project.id}`),
      ]);
      setTasks(taskResult.tasks);
      setDrafts(draftResult.drafts);
      setSessions(sessionResult.sessions.filter((session) => session.status !== 'READY'));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [project]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function describe() {
    const idea = readDraft(ideaRef.current).trim();
    if (idea.length < 10) {
      setError('Describe the idea in at least a sentence.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ sessionId: string }>('/api/ideas', { idea, projectId: project?.id });
      clearDraft(ideaRef.current);
      setComposing(false);
      router.push(`/ideas/${result.sessionId}`);
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!editing) return;
    const title = titleRef.current?.value.trim() ?? '';
    const body = readDraft(bodyRef.current).trim();
    if (!title || body.length < 10) {
      setError('A story needs a title and at least a sentence of description.');
      return;
    }
    setBusy(true);
    try {
      await api.put(`/api/drafts/${editing.id}`, { title, body });
      setEditing(null);
      await load();
    } catch (putError) {
      setError(putError instanceof Error ? putError.message : String(putError));
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
    } finally {
      setBusy(false);
    }
  }

  async function discard(draft: StoryDraft) {
    setBusy(true);
    try {
      await api.delete(`/api/drafts/${draft.id}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const visible = tasks.filter((task) => matches(filter, task.state));
  const waiting = tasks.filter((task) => explainState(task.state).tone === 'waiting').length;
  const active = tasks.filter((task) => explainState(task.state).tone === 'running').length;

  return (
    <div className="page enter">
      <div className="row-between">
        <div className="grow">
          <h1 className="display">Stories</h1>
          <p className="standfirst">
            Describe what should change in plain language. An idea is shaped into one or more stories first, and a story
            only starts when you launch it.
          </p>
        </div>
        <div className="row">
          <Button onClick={() => setComposing(true)} disabled={!project}>
            Describe an idea
          </Button>
        </div>
      </div>

      {error ? <ErrorText>{error}</ErrorText> : null}

      <div className="tiles">
        <Tile value={waiting} label="Waiting for you" tone={waiting > 0 ? 'attention' : undefined} />
        <Tile value={active} label="Running" />
        <Tile value={drafts.length} label="Drafts not started" tone="caution" />
        <Tile value={tasks.filter((task) => task.state === 'COMPLETED').length} label="Finished" tone="positive" />
      </div>

      {sessions.length > 0 ? (
        <section className="stack">
          <h2 className="subhead">Ideas being shaped</h2>
          <div className="list">
            {sessions.map((session) => (
              <div
                key={session.id}
                className="list-row clickable accent-waiting"
                onClick={() => router.push(`/ideas/${session.id}`)}
              >
                <div className="grow">
                  <div className="list-title">{session.idea.split('\n')[0]?.slice(0, 120)}</div>
                  <div className="meta" style={{ marginTop: 9 }}>
                    {session.status === 'ASKING'
                      ? 'Has questions for you'
                      : session.status === 'FAILED'
                        ? (session.error ?? 'Something went wrong')
                        : 'Working on it'}{' '}
                    · {relativeAge(session.createdAt)}
                  </div>
                </div>
                <span className={`badge ${session.status === 'ASKING' ? 'waiting' : session.status === 'FAILED' ? 'critical' : 'running'}`}>
                  {session.status === 'ASKING' ? 'Answer it' : session.status.toLowerCase()}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {drafts.length > 0 ? (
        <section className="stack">
          <div className="row-between">
            <h2 className="subhead">Drafts</h2>
            <span className="meta">Nothing runs until you launch it</span>
          </div>
          <div className="grid">
            {drafts.map((draft) => (
              <Card key={draft.id}>
                <span className="meta">
                  {draft.sequence > 0 ? `Part ${draft.sequence}` : 'Written by hand'} · {relativeAge(draft.createdAt)}
                </span>
                <div className="accent-rule" />
                <div className="list-title">{draft.title}</div>
                <p className="body-sm" style={{ color: 'var(--ivory-100)' }}>
                  {draft.body.slice(0, 320)}
                  {draft.body.length > 320 ? '…' : ''}
                </p>
                {draft.rationale ? <span className="body-sm">Why its own story: {draft.rationale}</span> : null}
                <div className="row" style={{ marginTop: 'auto' }}>
                  <Button size="sm" onClick={() => void launch(draft)} disabled={busy}>
                    Launch
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(draft)} disabled={busy}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void discard(draft)} disabled={busy}>
                    Discard
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      <section className="stack">
        <div className="row-between">
          <h2 className="subhead">Running and finished</h2>
          <div className="filters">
            {FILTERS.map((entry) => (
              <button
                key={entry.key}
                className={`filter ${filter === entry.key ? 'active' : ''}`}
                onClick={() => setFilter(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        {visible.length === 0 ? (
          <Empty>
            {tasks.length === 0
              ? 'No story has been started in this project yet.'
              : 'Nothing matches that filter right now.'}
          </Empty>
        ) : (
          <div className="list">
            {visible.map((task) => {
              const tone = explainState(task.state).tone;
              return (
                <div
                  key={task.id}
                  className={`list-row clickable accent-${tone === 'caution' ? 'running' : tone === 'critical' ? 'critical' : tone}`}
                  onClick={() => router.push(`/tasks/${task.id}`)}
                >
                  <div className="grow">
                    <div className="list-title">{task.storyTitle ?? task.branchName}</div>
                    <div className="meta" style={{ marginTop: 9 }}>
                      {relativeAge(task.createdAt)} · {task.branchName}
                      {task.baseMoved ? ' · the base has moved' : ''}
                    </div>
                  </div>
                  <div className="row">
                    {task.riskLevel ? <span className="badge caution">{task.riskLevel} risk</span> : null}
                    <StateBadge state={task.state} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <Dialog
        open={composing}
        onClose={() => setComposing(false)}
        eyebrow={`New idea · ${project?.name ?? ''}`}
        title="What should change?"
        footer={
          <>
            <Button onClick={() => void describe()} disabled={busy}>
              {busy ? 'Reading the project…' : 'Shape it into stories'}
            </Button>
            <Button variant="ghost" onClick={() => setComposing(false)}>
              Cancel
            </Button>
            <span className="meta">Read-only until you approve a plan</span>
          </>
        }
      >
        <p className="body-sm">
          Describe the behaviour you want, not the implementation. It will read the project, ask you two or three things
          it cannot work out by reading, and then write one or more stories you can edit before any of them starts.
        </p>
        <Field>
          <DraftTextarea
            textareaRef={ideaRef}
            rows={7}
            placeholder="When a user changes their email address, do not treat the new address as verified until they have confirmed it."
          />
        </Field>
      </Dialog>

      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        eyebrow="Edit the draft"
        title={editing?.title ?? ''}
        footer={
          <>
            <Button onClick={() => void saveDraft()} disabled={busy}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </>
        }
      >
        <Field label="Title">
          <input ref={titleRef} defaultValue={editing?.title ?? ''} />
        </Field>
        <Field label="The story">
          <DraftTextarea
            key={editing?.id ?? 'none'}
            textareaRef={bodyRef}
            rows={10}
            initialValue={editing?.body ?? ''}
            placeholder="Describe the behaviour to change."
          />
        </Field>
      </Dialog>
    </div>
  );
}
