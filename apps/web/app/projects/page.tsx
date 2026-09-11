'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Project } from '../../lib/api';
import { useProjects } from '../../components/shell';
import { Alert, Badge, Button, Card, Dialog, Empty, ErrorText, Field, KeyValue } from '../../components/ui';
import { relativeAge } from '../../lib/format';

const SETUP_TONES: Record<Project['setupState'], 'waiting' | 'running' | 'done' | 'critical'> = {
  PENDING: 'waiting',
  RUNNING: 'running',
  READY: 'done',
  FAILED: 'critical',
};

const SETUP_WORDS: Record<Project['setupState'], string> = {
  PENDING: 'Queued for setup',
  RUNNING: 'Being prepared',
  READY: 'Ready',
  FAILED: 'Could not be prepared',
};

const ACCESS_WORDS: Record<Project['remoteAccess'], string> = {
  UNKNOWN: 'not checked',
  NONE: 'no access — stories stay on local branches',
  READ: 'read only — nothing can be pushed',
  WRITE: 'push and pull requests',
};

/**
 * The projects this installation serves.
 *
 * One installation used to mean one repository, fixed when it was installed. Now
 * the installation is the engine and projects are something you add and remove
 * while it runs, which is why adding one has to do real work: it reads the
 * project to find out how it builds and walks it once for the first knowledge
 * snapshot. That happens in the background, and a project is not usable until it
 * has finished.
 *
 * Nothing is written into a project you add. Not a marker, not a manifest, not a
 * rules directory. What the system learns about it lives in the database, and
 * the directory is used only to run stories in, on branches of their own.
 */
export default function ProjectsPage() {
  const { reload, select } = useProjects();
  const [projects, setProjects] = useState<Project[]>([]);
  const [branches, setBranches] = useState<Record<string, string[]>>({});
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ projects: Project[] }>('/api/projects');
      setProjects(result.projects);
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

  async function add() {
    const repoPath = pathRef.current?.value.trim() ?? '';
    if (!repoPath) {
      setError('Give the absolute path of the repository.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ project: Project }>('/api/projects', {
        repoPath,
        name: nameRef.current?.value.trim() || undefined,
      });
      setAdding(false);
      select(result.project.id);
      await load();
      await reload();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  async function remove(project: Project, force: boolean) {
    setBusy(true);
    try {
      await api.delete(`/api/projects/${project.id}${force ? '?force=true' : ''}`);
      setRemoving(null);
      await load();
      await reload();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setBusy(false);
    }
  }

  /** Loaded when the picker is opened, not for every project on the page. */
  async function loadBranches(project: Project) {
    if (branches[project.id]) return;
    const result = await api
      .get<{ branches: string[] }>(`/api/projects/${project.id}/branches`)
      .catch(() => ({ branches: [] as string[] }));
    setBranches((current) => ({ ...current, [project.id]: result.branches }));
  }

  async function setWorkBranch(project: Project, workBranch: string) {
    setBusy(true);
    try {
      await api.put(`/api/projects/${project.id}`, { workBranch });
      await load();
      await reload();
    } catch (putError) {
      setError(putError instanceof Error ? putError.message : String(putError));
    } finally {
      setBusy(false);
    }
  }

  async function retrySetup(project: Project) {
    setBusy(true);
    try {
      await api.post(`/api/projects/${project.id}/retry-setup`);
      await load();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  const work = projects.filter((project) => project.kind === 'PROJECT');
  const installation = projects.find((project) => project.kind === 'INSTALLATION') ?? null;

  return (
    <div className="page enter">
      <div className="row-between">
        <div className="grow">
          <h1 className="display">Projects</h1>
          <p className="standfirst">
            Every project here shares one queue and one account limit, and keeps its own knowledge, principles, stories
            and chats. Nothing is shared between them except the order work runs in.
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>Add a project</Button>
      </div>

      {error ? <ErrorText>{error}</ErrorText> : null}

      {work.length === 0 ? (
        <Empty>No project yet. Add the directory of a Git repository with at least one commit.</Empty>
      ) : (
        <div className="grid">
          {work.map((project) => (
            <Card key={project.id}>
              <div className="row-between">
                <span className="meta">{project.workBranch}</span>
                <Badge tone={SETUP_TONES[project.setupState]}>{SETUP_WORDS[project.setupState]}</Badge>
              </div>
              <div className="accent-rule" />
              <h2 className="subhead">{project.name}</h2>
              <div className="mono">{project.repoPath}</div>

              {project.setupState === 'FAILED' ? (
                <Alert tone="critical" title="Setup did not finish">
                  {project.setupError ?? 'No reason was recorded.'}
                </Alert>
              ) : null}
              {project.setupState === 'RUNNING' || project.setupState === 'PENDING' ? (
                <span className="body-sm">
                  Working out how this project builds and reading it once. A story cannot start until that is done.
                </span>
              ) : null}

              {project.mergeConflictTaskId ? (
                <Alert tone="caution" title="A merge is waiting in this directory">
                  A story stopped on conflicts, so nothing else can run here until they are resolved or the merge is
                  abandoned. Open the story to choose.
                </Alert>
              ) : null}

              <Field
                label="Work branch"
                hint="Stories start from this branch and are merged back into it."
              >
                <select
                  value={project.workBranch}
                  disabled={busy}
                  onFocus={() => void loadBranches(project)}
                  onChange={(event) => void setWorkBranch(project, event.target.value)}
                >
                  {(branches[project.id] ?? [project.workBranch]).map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </Field>

              <KeyValue label="Remote">{project.remoteUrl ?? 'none — pull requests are off'}</KeyValue>
              <KeyValue label="Access">{ACCESS_WORDS[project.remoteAccess]}</KeyValue>
              <KeyValue label="Knowledge">
                {project.knowledgeSnapshot
                  ? `snapshot ${project.knowledgeSnapshot.sequence} · ${project.knowledgeSnapshot.gitCommit.slice(0, 10)}`
                  : 'none yet'}
              </KeyValue>
              <KeyValue label="How it builds">
                {project.runtimeManifest
                  ? `v${project.runtimeManifest.version}${project.runtimeManifest.validated ? ' · proven' : ' · not proven'}`
                  : 'unknown'}
              </KeyValue>
              <KeyValue label="Stories">
                {Object.values(project.taskCounts ?? {}).reduce((total, count) => total + count, 0)}
              </KeyValue>
              <KeyValue label="Added">{relativeAge(project.createdAt)}</KeyValue>

              <div className="row" style={{ marginTop: 'auto' }}>
                <Button size="sm" variant="secondary" onClick={() => select(project.id)}>
                  Work on this
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void api.post(`/api/projects/${project.id}/knowledge-refresh`)}
                  disabled={busy}
                >
                  Re-read it
                </Button>
                {project.setupState === 'FAILED' ? (
                  <Button size="sm" variant="ghost" onClick={() => void retrySetup(project)} disabled={busy}>
                    Try setup again
                  </Button>
                ) : null}
                <Button size="sm" variant="danger" onClick={() => setRemoving(project)} disabled={busy}>
                  Remove
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {installation ? (
        <Card tone="olive">
          <span className="meta" style={{ color: 'rgba(242,229,200,0.82)' }}>
            The engine itself
          </span>
          <h2 className="subhead">{installation.name}</h2>
          <div className="mono">{installation.repoPath}</div>
          <p className="body-sm" style={{ color: 'rgba(242,229,200,0.82)' }}>
            The installation is registered as a project too, so a story can change how the system behaves. Work against
            it is never pushed: it waits on a local branch until you apply it, which restarts everything onto it.
          </p>
          <div className="row">
            <Button size="sm" variant="secondary" onClick={() => select(installation.id)}>
              Write a story for the engine
            </Button>
          </div>
        </Card>
      ) : null}

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        eyebrow="Add a project"
        title="Which repository?"
        footer={
          <>
            <Button onClick={() => void add()} disabled={busy}>
              {busy ? 'Checking it…' : 'Add it'}
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </>
        }
      >
        <p className="body-sm">
          The absolute path of a Git repository with at least one commit. Nothing is written into it, now or ever:
          everything this system learns about the project lives in its own database. Stories run in this directory, each
          on a branch of its own, one at a time.
        </p>
        <Field label="Path">
          <input ref={pathRef} placeholder="/Users/you/work/payments-api" />
        </Field>
        <Field label="Name" hint="Optional. The directory name is used if you leave this empty.">
          <input ref={nameRef} placeholder="payments-api" />
        </Field>
      </Dialog>

      <Dialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        eyebrow="Remove a project"
        title={removing?.name ?? ''}
        footer={
          <>
            <Button variant="danger" onClick={() => removing && void remove(removing, false)} disabled={busy}>
              Remove it
            </Button>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
          </>
        }
      >
        <p className="body-sm">
          This removes every story, plan, check, snapshot, principle, chat and artifact belonging to {removing?.name}.
          It cannot be undone.
        </p>
        <p className="body-sm">
          Your repository at <span className="mono">{removing?.repoPath}</span> is not touched. Nothing of ours was ever
          written into it. The branches your stories made stay where they are, for you to keep or delete.
        </p>
      </Dialog>
    </div>
  );
}
