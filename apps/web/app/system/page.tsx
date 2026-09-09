'use client';

import { useEffect, useState } from 'react';
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
  const [status, setStatus] = useState<Status | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [version, setVersion] = useState<Version | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [statusResult, healthResult, versionResult] = await Promise.all([
          api.get<Status>('/api/system/status'),
          api.get<Health>('/api/health'),
          api.get<Version>('/api/system/version').catch(() => null),
        ]);
        setStatus(statusResult);
        setHealth(healthResult);
        setVersion(versionResult);
        setError(null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!status || !health) return <p className="empty">Loading...</p>;

  return (
    <div>
      <h2>System Status</h2>
      <p className="subtitle">{status.project.name} · {status.project.repoPath}</p>

      <div className="grid">
        <div className="card">
          <div className="meta">Services</div>
          <div>Database: {health.database ? 'up' : 'down'}</div>
          <div>Sandbox manager: {health.sandboxManager ? 'up' : 'down'}</div>
          <div>Sandboxing: {health.sandboxEnabled ? 'docker' : 'host worktrees'}</div>
        </div>
        <div className="card">
          <div className="meta">Agent engine</div>
          <div>{health.agentEngine}</div>
          <div className="meta">{health.agentEngineReady ? health.claudeCliVersion ?? 'ready' : 'not available'}</div>
          <div className="meta">{health.model}</div>
        </div>
        <div className="card">
          <div className="meta">Installation</div>
          <div>{version ? `${version.tag ?? version.commit.slice(0, 10)} · ${VERSION_LABELS[version.state]}` : 'unknown'}</div>
          <div className="meta">
            {version?.state === 'behind' ? `latest release ${version.latestRelease}` : null}
            {version?.state === 'diverged'
              ? `${version.localCommits} local commit(s)${version.dirty ? ' and uncommitted changes' : ''}`
              : null}
            {version?.state === 'up_to_date' ? `matches ${version.latestRelease}` : null}
          </div>
          <div className="meta">{version?.installRoot ?? ''}</div>
        </div>
        <div className="card">
          <div className="meta">Repository</div>
          <div>{status.repository.defaultBranch}</div>
          <div className="meta">{status.repository.head?.slice(0, 10) ?? 'unknown'}</div>
          <div className="meta">{status.repository.remoteUrl ?? 'no remote'}</div>
        </div>
        <div className="card">
          <div className="meta">Runtime manifest</div>
          <div>{status.runtimeManifest ? `v${status.runtimeManifest.version}` : 'none'}</div>
          <div className="meta">
            {status.runtimeManifest?.manifest.project.language.join(', ') || 'no language detected'}
          </div>
          <div className="meta">{status.runtimeManifest?.validated ? 'validated' : 'not validated'}</div>
        </div>
        <div className="card">
          <div className="meta">Knowledge</div>
          <div>{status.knowledgeSnapshot ? `snapshot ${status.knowledgeSnapshot.sequence}` : 'none'}</div>
          <div className="meta">{status.knowledgeSnapshot?.gitCommit.slice(0, 10) ?? ''}</div>
        </div>
        <div className="card">
          <div className="meta">Jobs</div>
          {Object.entries(status.jobs).length === 0 ? (
            <div className="meta">idle</div>
          ) : (
            Object.entries(status.jobs).map(([key, value]) => (
              <div key={key}>
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
        <table>
          <tbody>
            {status.tasks.map((task) => (
              <tr key={task.id}>
                <td style={{ width: 260 }}>
                  <Link href={`/tasks/${task.id}`}>{task.branchName}</Link>
                </td>
                <td style={{ width: 260 }}>
                  <StateBadge state={task.state} />
                </td>
                <td className="meta">{task.baseCommit.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {status.conflicts.length > 0 ? (
        <>
          <h3>Open conflicts</h3>
          <table>
            <tbody>
              {status.conflicts.map((conflict) => (
                <tr key={conflict.id}>
                  <td style={{ width: 110 }}>{conflict.severity}</td>
                  <td style={{ width: 240 }}>{conflict.resource}</td>
                  <td>{conflict.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}
