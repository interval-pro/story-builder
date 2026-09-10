'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, type Task } from '../../lib/api';
import { StateBadge } from '../../components/state-badge';

interface Status {
  project: { name: string; repoPath: string; defaultBranch: string; remoteUrl: string | null };
  activeTasks: number;
  tasks: Task[];
  jobs: Record<string, number>;
  conflicts: { id: string; resource: string; severity: string; description: string }[];
  runtimeManifest: { version: number; validated: boolean; manifest: { project: { language: string[] }; test: { commands: string[] } } } | null;
  knowledgeSnapshot: { sequence: number; gitCommit: string } | null;
  repository: { defaultBranch: string; head: string | null; remoteUrl: string | null };
}

interface Version {
  installRoot: string;
  projectRoot: string;
  tag: string | null;
  commit: string;
  localCommits: number;
  dirty: boolean;
  latestRelease: string | null;
  releaseUrl: string | null;
  state: 'up_to_date' | 'behind' | 'diverged' | 'unknown';
}

const VERSION_LABELS: Record<Version['state'], string> = {
  up_to_date: 'up to date',
  behind: 'update available',
  diverged: 'changed locally',
  unknown: 'unknown',
};

/** The version state is one of the two facts this page exists to show, so it
 *  carries a badge tone rather than receding into the detail lines. */
const VERSION_TONES: Record<Version['state'], string> = {
  up_to_date: 'done',
  behind: 'attention',
  diverged: 'attention',
  unknown: 'waiting',
};

interface ApplyRecord {
  id: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';
  step: string;
  log: string;
  candidateRef: string;
  source: 'TASK' | 'UPSTREAM';
  finishedAt: string | null;
}

interface Health {
  status: string;
  database: boolean;
  sandboxManager: boolean;
  agentEngine: string;
  agentEngineReady: boolean;
  claudeCliVersion: string | null;
  aiProvider: string;
  model: string;
  sandboxEnabled: boolean;
}

export default function SystemPage() {
  const syncingRef = useRef(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [version, setVersion] = useState<Version | null>(null);
  const [apply, setApply] = useState<ApplyRecord | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [statusResult, healthResult, versionResult, applyResult] = await Promise.all([
          api.get<Status>('/api/system/status'),
          api.get<Health>('/api/health'),
          api.get<Version>('/api/system/version').catch(() => null),
          api.get<{ apply: ApplyRecord | null }>('/api/system/apply').catch(() => ({ apply: null })),
        ]);
        setStatus(statusResult);
        setHealth(healthResult);
        setVersion(versionResult);
        setApply(applyResult.apply);
        setUnreachable(false);
        if (applyResult.apply?.status !== 'RUNNING') setSyncing(false);
        setError(null);
      } catch (loadError) {
        // While an update is being applied the API is deliberately down, so a
        // failed poll is expected rather than an error worth showing.
        if (syncingRef.current) setUnreachable(true);
        else setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    syncingRef.current = syncing;
  }, [syncing]);

  async function sync() {
    const confirmed = window.confirm(
      `Updating to ${version?.latestRelease} stops the whole system: the cockpit, the API, the orchestrator ` +
        'and the worker.\n\nIt then fetches the release, rebuilds, migrates, runs the tests and starts ' +
        'everything again. This takes a few minutes and the page will be unreachable while it happens.\n\n' +
        'If anything fails the current version is restored automatically.\n\nUpdate now?',
    );
    if (!confirmed) return;
    setSyncing(true);
    setUnreachable(false);
    try {
      await api.post('/api/system/sync', {});
    } catch (syncError) {
      setSyncing(false);
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!status || !health) return <p className="empty">Reading the system status and the health check.</p>;

  const applying = syncing || apply?.status === 'RUNNING';

  return (
    <div>
      <h2>System Status</h2>
      <p className="subtitle">{status.project.name} · {status.project.repoPath}</p>

      <div className="grid">
        <div className="card">
          <div className="card-label">Services</div>
          <div className="card-value">Database: {health.database ? 'up' : 'down'}</div>
          <div className="card-detail">Sandbox manager: {health.sandboxManager ? 'up' : 'down'}</div>
          <div className="card-detail">Sandboxing: {health.sandboxEnabled ? 'docker' : 'host worktrees'}</div>
        </div>
        <div className="card">
          <div className="card-label">Agent engine</div>
          <div className="card-value">{health.agentEngine}</div>
          <div className="card-detail">{health.agentEngineReady ? health.claudeCliVersion ?? 'ready' : 'not available'}</div>
          <div className="card-detail">{health.model}</div>
        </div>
        <div className="card">
          <div className="card-label">Installation</div>
          <div className="card-value">{version ? version.tag ?? version.commit.slice(0, 10) : 'unknown'}</div>
          {version ? (
            <div className="row">
              <span className={`badge ${VERSION_TONES[version.state]}`}>{VERSION_LABELS[version.state]}</span>
            </div>
          ) : null}
          <div className="card-detail">
            {version?.state === 'behind' ? `latest release ${version.latestRelease}` : null}
            {version?.state === 'diverged'
              ? `${version.localCommits} local commit(s)${version.dirty ? ' and uncommitted changes' : ''}`
              : null}
            {version?.state === 'up_to_date' ? `matches ${version.latestRelease}` : null}
          </div>
          <div className="card-detail">{version?.installRoot ?? ''}</div>
          {applying || version?.state === 'behind' ? (
            <div className="actions">
              {applying ? (
                <span className="card-detail">
                  {unreachable ? 'The system is restarting. This page will come back on its own.' : `Updating: ${apply?.step ?? 'starting'}`}
                </span>
              ) : null}
              {!applying && version?.state === 'behind' ? (
                <button onClick={() => void sync()}>Update to {version.latestRelease}</button>
              ) : null}
            </div>
          ) : null}
          {!applying && apply && apply.source === 'UPSTREAM' && apply.status !== 'SUCCEEDED' ? (
            <p className="error">
              The last update did not finish and the previous version was restored.{' '}
              {apply.log.trim().split('\n').slice(-1)[0]}
            </p>
          ) : null}
        </div>
        <div className="card">
          <div className="card-label">Repository</div>
          <div className="card-value">{status.repository.defaultBranch}</div>
          <div className="card-detail">{status.repository.head?.slice(0, 10) ?? 'unknown'}</div>
          <div className="card-detail">{status.repository.remoteUrl ?? 'no remote'}</div>
        </div>
        <div className="card">
          <div className="card-label">Runtime manifest</div>
          <div className="card-value">{status.runtimeManifest ? `v${status.runtimeManifest.version}` : 'none'}</div>
          <div className="card-detail">
            {status.runtimeManifest?.manifest.project.language.join(', ') || 'no language detected'}
          </div>
          <div className="card-detail">{status.runtimeManifest?.validated ? 'validated' : 'not validated'}</div>
        </div>
        <div className="card">
          <div className="card-label">Knowledge</div>
          <div className="card-value">{status.knowledgeSnapshot ? `snapshot ${status.knowledgeSnapshot.sequence}` : 'none'}</div>
          <div className="card-detail">{status.knowledgeSnapshot?.gitCommit.slice(0, 10) ?? ''}</div>
        </div>
        <div className="card">
          <div className="card-label">Jobs</div>
          {Object.entries(status.jobs).length === 0 ? (
            <div className="card-value">idle</div>
          ) : (
            Object.entries(status.jobs).map(([key, value]) => (
              <div key={key} className="card-value">
                {key}: {value}
              </div>
            ))
          )}
        </div>
      </div>

      <h3>Active tasks ({status.activeTasks})</h3>
      {status.tasks.length === 0 ? (
        <p className="empty">Nothing is running.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <tbody>
              {status.tasks.map((task) => (
                <tr key={task.id}>
                  <td className="col-lg">
                    <Link href={`/tasks/${task.id}`}>{task.branchName}</Link>
                  </td>
                  <td className="col-lg">
                    <StateBadge state={task.state} />
                  </td>
                  <td className="meta">{task.baseCommit.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status.conflicts.length > 0 ? (
        <>
          <h3>Open conflicts</h3>
          <div className="table-scroll">
            <table>
              <tbody>
                {status.conflicts.map((conflict) => (
                  <tr key={conflict.id}>
                    <td className="col-sm">{conflict.severity}</td>
                    <td className="col-lg">{conflict.resource}</td>
                    <td>{conflict.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
