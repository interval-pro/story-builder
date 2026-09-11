'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type UsageView } from '../../lib/api';
import { Alert, Badge, Bar, Button, Card, Empty, ErrorText, KeyValue, Tile } from '../../components/ui';
import { formatTokens, formatTokensExact, relativeAge } from '../../lib/format';

interface Health {
  status: string;
  database: boolean;
  agentEngine: string;
  agentEngineReady: boolean;
  claudeCliVersion: string | null;
  model: string;
  installRoot: string;
  stateRoot: string;
}

/**
 * What is running against what is checked out, and what exists upstream.
 *
 * Two separate facts, because they have two different answers. Local commits
 * that are not running are fixed by rebuilding; a newer release is fixed by
 * updating. A single "out of date" badge would tell you neither.
 */
interface BuildStatus {
  builtCommit: string | null;
  builtAt: string | null;
  headCommit: string;
  commitsAhead: number;
  hasUnbuiltChanges: boolean;
  dirty: boolean;
  latestRelease: string | null;
  releaseIsNewer: boolean;
  currentTag: string | null;
}

interface Version {
  installRoot: string;
  tag: string | null;
  commit: string;
  localCommits: number;
  dirty: boolean;
  latestRelease: string | null;
  releaseUrl: string | null;
  state: 'up_to_date' | 'behind' | 'diverged' | 'unknown';
}

interface ApplyRecord {
  id: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';
  step: string;
  log: string;
  candidateRef: string;
  source: 'TASK' | 'UPSTREAM' | 'LOCAL';
  finishedAt: string | null;
}

const VERSION_WORDS: Record<Version['state'], string> = {
  up_to_date: 'Up to date',
  behind: 'Update available',
  diverged: 'Changed locally',
  unknown: 'Unknown',
};

const VERSION_TONES: Record<Version['state'], 'done' | 'waiting' | 'caution'> = {
  up_to_date: 'done',
  behind: 'caution',
  diverged: 'caution',
  unknown: 'waiting',
};

/**
 * What is running, what it costs, and how far this installation has drifted.
 *
 * Nothing on this page is money. The account is a subscription with a weekly
 * token limit, and the engine reports no limit field of any kind, so the budget
 * shown is one the owner set and the page says so.
 */
export default function SystemPage() {
  const syncingRef = useRef(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [version, setVersion] = useState<Version | null>(null);
  const [build, setBuild] = useState<BuildStatus | null>(null);
  const [apply, setApply] = useState<ApplyRecord | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [jobs, setJobs] = useState<Record<string, number>>({});
  const [syncing, setSyncing] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [healthResult, versionResult, buildResult, applyResult, usageResult, jobResult] = await Promise.all([
          api.get<Health>('/api/health'),
          api.get<Version>('/api/system/version').catch(() => null),
          api.get<BuildStatus>('/api/system/build').catch(() => null),
          api.get<{ apply: ApplyRecord | null }>('/api/system/apply').catch(() => ({ apply: null })),
          api.get<UsageView>('/api/usage?windowHours=168').catch(() => null),
          api.get<{ stats: Record<string, number> }>('/api/jobs').catch(() => ({ stats: {} })),
        ]);
        setHealth(healthResult);
        setVersion(versionResult);
        setBuild(buildResult);
        setApply(applyResult.apply);
        setUsage(usageResult);
        setJobs(jobResult.stats);
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
      await api.post('/api/system/sync');
    } catch (syncError) {
      setSyncing(false);
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    }
  }

  async function rebuild() {
    const confirmed = window.confirm(
      'Rebuilding runs the commits already in this checkout.\n\nThe new version is built first, while the ' +
        'current one keeps serving, so a build that fails costs nothing. Only once it succeeds is the database ' +
        'snapshotted, the services stopped, the migrations run and everything started again.\n\nIf anything ' +
        'fails after that, the version that was running is restored.\n\nRebuild now?',
    );
    if (!confirmed) return;
    setSyncing(true);
    setUnreachable(false);
    try {
      await api.post('/api/system/rebuild');
    } catch (rebuildError) {
      setSyncing(false);
      setError(rebuildError instanceof Error ? rebuildError.message : String(rebuildError));
    }
  }

  if (error) return <div className="page"><ErrorText>{error}</ErrorText></div>;
  if (!health) return <div className="page">Reading the system.</div>;

  const applying = syncing || apply?.status === 'RUNNING';
  const week = usage?.week;

  return (
    <div className="page enter">
      <div>
        <h1 className="display">System</h1>
        <p className="standfirst">
          What is running, what the agents have used, and how far this installation has drifted from the released
          version.
        </p>
      </div>

      <div className="tiles">
        <Tile value={health.database ? 'Up' : 'Down'} label="Database" tone={health.database ? 'positive' : 'attention'} />
        <Tile
          value={health.agentEngineReady ? 'Ready' : 'Missing'}
          label="Agent engine"
          tone={health.agentEngineReady ? 'positive' : 'attention'}
        />
        <Tile value={Object.values(jobs).reduce((total, count) => total + count, 0)} label="Jobs on record" />
        <Tile value={week ? formatTokens(week.usedTokens) : '—'} label="Tokens this week" />
      </div>

      {build && build.hasUnbuiltChanges && !applying ? (
        <Alert tone="caution" title="There are changes here that are not running">
          {build.builtCommit
            ? `The running version was built from ${build.builtCommit.slice(0, 10)}. The checkout is ${
                build.commitsAhead > 0 ? `${build.commitsAhead} commit(s) ahead` : 'on a different commit'
              }${build.dirty ? ', with uncommitted changes that no build would pick up' : ''}.`
            : 'Nothing records which commit the running version was built from, so it is treated as unbuilt.'}
        </Alert>
      ) : null}

      {!health.agentEngineReady ? (
        <Alert tone="critical" title="The engine is not available">
          The Claude Code CLI could not be run. Nothing can happen until it is installed and logged in.
        </Alert>
      ) : null}

      <div className="split">
        <div className="wide stack">
          <Card>
            <span className="meta">Installation</span>
            <div className="row-between">
              <h2 className="subhead">{version ? (version.tag ?? version.commit.slice(0, 10)) : 'unknown'}</h2>
              {version ? <Badge tone={VERSION_TONES[version.state]}>{VERSION_WORDS[version.state]}</Badge> : null}
            </div>
            {version?.state === 'behind' ? (
              <span className="body-sm">The newest release is {version.latestRelease}.</span>
            ) : null}
            {version?.state === 'diverged' ? (
              <span className="body-sm">
                {version.localCommits} local commit(s)
                {version.dirty ? ' and uncommitted changes' : ''}. An update would merge rather than fast-forward.
              </span>
            ) : null}
            {version?.state === 'up_to_date' ? (
              <span className="body-sm">This matches {version.latestRelease} exactly.</span>
            ) : null}
            <div className="mono">{version?.installRoot}</div>

            {applying ? (
              <>
                <span className="meta">
                  {unreachable
                    ? 'The system is restarting. This page comes back on its own.'
                    : `Updating: ${apply?.step ?? 'starting'}`}
                </span>
                <Bar percent={60} tone="caution" />
              </>
            ) : (
              <div className="row">
                {build?.hasUnbuiltChanges && !build.dirty ? (
                  <Button onClick={() => void rebuild()}>Rebuild onto {build.headCommit.slice(0, 10)}</Button>
                ) : null}
                {version?.state === 'behind' || build?.releaseIsNewer ? (
                  <Button variant="secondary" onClick={() => void sync()}>
                    Update to {version?.latestRelease ?? build?.latestRelease}
                  </Button>
                ) : null}
                {build?.dirty ? (
                  <span className="meta">Commit or discard the uncommitted changes before rebuilding</span>
                ) : null}
              </div>
            )}

            {!applying && apply && apply.status !== 'SUCCEEDED' ? (
              <ErrorText>
                The last {apply.source === 'UPSTREAM' ? 'update' : 'apply'} did not finish and the previous version was
                restored. {apply.log.trim().split('\n').slice(-1)[0]}
              </ErrorText>
            ) : null}
            {!applying && apply?.status === 'SUCCEEDED' ? (
              <span className="meta">
                Last applied {relativeAge(apply.finishedAt)} · {apply.candidateRef}
              </span>
            ) : null}
          </Card>

          {usage ? (
            <Card>
              <span className="meta">Usage, last seven days, every project</span>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Runs</th>
                      <th>Tokens</th>
                      <th>Nothing recorded</th>
                      <th>Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.window.byAgent.map((agent) => (
                      <tr key={agent.agentType}>
                        <td>{agent.agentType}</td>
                        <td className="num">{agent.runs}</td>
                        <td className="num">{formatTokensExact(agent.totalTokens)}</td>
                        <td className="num">{agent.unrecordedRuns}</td>
                        <td className="num">{agent.failedRuns}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <span className="body-sm">{usage.provenance.perRun}. {usage.provenance.window}.</span>
            </Card>
          ) : (
            <Empty>No usage has been recorded yet.</Empty>
          )}
        </div>

        <div className="narrow stack">
          <Card tone="olive">
            <span className="meta" style={{ color: 'rgba(242,229,200,0.82)' }}>
              The week
            </span>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 52, lineHeight: 0.95 }}>
              {week ? formatTokens(week.usedTokens) : '—'}
            </div>
            <span className="meta" style={{ color: 'rgba(242,229,200,0.82)' }}>
              Tokens, rolling seven days
            </span>
            {week?.budgetTokens ? (
              <>
                <Bar percent={week.percentOfBudget ?? 0} tone={(week.percentOfBudget ?? 0) > 80 ? 'critical' : undefined} />
                <span className="body-sm" style={{ color: 'rgba(242,229,200,0.82)' }}>
                  {week.percentOfBudget}% of the budget you set.
                </span>
              </>
            ) : null}
            <span className="body-sm" style={{ color: 'rgba(242,229,200,0.82)' }}>
              {usage?.provenance.limit}
            </span>
            {week?.reportedLimit ? (
              <div className="mono">{JSON.stringify(week.reportedLimit).slice(0, 300)}</div>
            ) : null}
          </Card>

          <Card>
            <span className="meta">Services</span>
            <KeyValue label="Database">{health.database ? 'up' : 'down'}</KeyValue>
            <KeyValue label="Engine">{health.agentEngine}</KeyValue>
            <KeyValue label="CLI">{health.claudeCliVersion ?? 'unknown'}</KeyValue>
            <KeyValue label="Model">{health.model}</KeyValue>
            <KeyValue label="Running">
              {build?.builtCommit ? `${build.builtCommit.slice(0, 10)}, built ${relativeAge(build.builtAt)}` : 'unknown'}
            </KeyValue>
            <KeyValue label="Checked out">{build?.headCommit.slice(0, 10) ?? '—'}</KeyValue>
            <KeyValue label="State">{health.stateRoot}</KeyValue>
          </Card>

          <Card>
            <span className="meta">Jobs on record</span>
            {Object.keys(jobs).length === 0 ? (
              <Empty>None.</Empty>
            ) : (
              Object.entries(jobs).map(([status, count]) => (
                <KeyValue key={status} label={status.toLowerCase()}>
                  {count}
                </KeyValue>
              ))
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
