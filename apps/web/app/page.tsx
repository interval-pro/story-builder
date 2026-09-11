'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, type Task, type UsageView } from '../lib/api';
import { useProjects } from '../components/shell';
import { Alert, Bar, Button, Card, Empty, ErrorText, StateBadge, Tile } from '../components/ui';
import { formatTokens, formatTokensExact, relativeAge } from '../lib/format';
import { explainState, jobLabel } from '../lib/labels';

/**
 * What the whole installation is doing, in one screen.
 *
 * Two lists, in this order, because the order is the point: what is waiting for
 * you comes before what the machine is busy with. A person opening this wants to
 * know whether anything is stuck on them, and everything else is reassurance.
 */
export default function OverviewPage() {
  const { projects, queue, loading } = useProjects();
  const router = useRouter();
  const [running, setRunning] = useState<Task[]>([]);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [recent, setRecent] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [all, usageResult] = await Promise.all([
          api.get<{ tasks: Task[]; waiting: Task[] }>('/api/tasks?allProjects=true'),
          api.get<UsageView>('/api/usage?windowHours=24'),
        ]);
        setRunning(all.tasks);
        setUsage(usageResult);
        setError(null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  // Finished work, per project, so the overview has a record of what came out of
  // the system rather than only what is in flight.
  useEffect(() => {
    async function load() {
      const lists = await Promise.all(
        projects
          .filter((project) => project.kind === 'PROJECT')
          .map((project) =>
            api
              .get<{ tasks: Task[] }>(`/api/tasks?projectId=${project.id}`)
              .then((result) => result.tasks)
              .catch(() => []),
          ),
      );
      const finished = lists
        .flat()
        .filter((task) => ['COMPLETED', 'PR_CREATED', 'STOPPED'].includes(task.state))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 6);
      setRecent(finished);
    }
    if (projects.length > 0) void load();
  }, [projects]);

  const waiting = queue?.waiting ?? [];
  const week = usage?.week;

  if (loading) return <div className="page">Reading the installation.</div>;

  if (projects.filter((project) => project.kind === 'PROJECT').length === 0) {
    return (
      <div className="page enter">
        <div>
          <h1 className="display">Nothing to work on yet</h1>
          <p className="standfirst">
            An installation serves as many repositories as you add to it. Add the first one and it will work out how the
            project builds and read it once before anything else happens.
          </p>
        </div>
        <div className="row">
          <Button onClick={() => router.push('/projects')}>Add a project</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="page enter">
      <div className="row-between">
        <div className="grow">
          <h1 className="display">Overview</h1>
          <p className="standfirst">
            Everything in flight, across every project. What is waiting for you is first, because nothing else moves
            until it is answered.
          </p>
        </div>
      </div>

      {error ? <ErrorText>{error}</ErrorText> : null}

      <div className="tiles">
        <Tile value={waiting.length} label="Waiting for you" tone={waiting.length > 0 ? 'attention' : undefined} />
        <Tile value={queue?.running ?? 0} label="Running now" />
        <Tile value={queue?.pending ?? 0} label="In the queue" tone="caution" />
        <Tile
          value={week ? formatTokens(week.usedTokens) : '—'}
          label="Tokens this week"
          tone={week?.percentOfBudget !== null && (week?.percentOfBudget ?? 0) > 80 ? 'attention' : undefined}
        />
      </div>

      {queue?.policy.paused ? (
        <Alert tone="caution" title="The queue is paused">
          Nothing new will start. Work that was already running is finishing rather than being killed, and everything
          waiting keeps its place in the order.
        </Alert>
      ) : null}

      <section className="stack">
        <div className="row-between">
          <h2 className="subhead">Waiting for you</h2>
          <span className="meta">{waiting.length} item(s)</span>
        </div>
        {waiting.length === 0 ? (
          <Empty>Nothing is waiting on you. Everything here is either running or finished.</Empty>
        ) : (
          <div className="list">
            {waiting.map((item) => (
              <div
                key={item.taskId}
                className="list-row clickable accent-waiting"
                onClick={() => router.push(`/tasks/${item.taskId}`)}
              >
                <div className="grow">
                  <div className="list-title">{item.storyTitle}</div>
                  <div className="meta" style={{ marginTop: 9 }}>
                    {item.projectName} · {relativeAge(item.since)}
                    {item.openDecisions > 0 ? ` · ${item.openDecisions} decision(s) to answer` : ''}
                  </div>
                  {item.blockedReason ? <div className="body-sm">{item.blockedReason}</div> : null}
                </div>
                <StateBadge state={item.state} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="stack">
        <div className="row-between">
          <h2 className="subhead">Running</h2>
          <Link href="/queue" className="meta">
            The whole queue →
          </Link>
        </div>
        {running.length === 0 ? (
          <Empty>No agent is working right now.</Empty>
        ) : (
          <div className="list">
            {running.map((task) => (
              <div
                key={task.id}
                className="list-row clickable accent-running"
                onClick={() => router.push(`/tasks/${task.id}`)}
              >
                <div className="grow">
                  <div className="list-title">{task.storyTitle}</div>
                  <div className="meta" style={{ marginTop: 9 }}>
                    {task.projectName} · {explainState(task.state).means}
                  </div>
                </div>
                <StateBadge state={task.state} />
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="split">
        <div className="wide stack">
          <h2 className="subhead">Finished recently</h2>
          {recent.length === 0 ? (
            <Empty>Nothing has finished yet.</Empty>
          ) : (
            <div className="list">
              {recent.map((task) => (
                <div
                  key={task.id}
                  className="list-row clickable accent-done"
                  onClick={() => router.push(`/tasks/${task.id}`)}
                >
                  <div className="grow">
                    <div className="list-title">{task.storyTitle}</div>
                    <div className="meta" style={{ marginTop: 9 }}>
                      {task.projectName} · {relativeAge(task.updatedAt)}
                    </div>
                  </div>
                  <StateBadge state={task.state} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="narrow stack">
          <Card tone="olive">
            <span className="meta" style={{ color: 'rgba(242,229,200,0.82)' }}>
              Tokens, rolling seven days
            </span>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 46, lineHeight: 0.95 }}>
              {week ? formatTokens(week.usedTokens) : '—'}
            </div>
            {week?.budgetTokens ? (
              <>
                <Bar percent={week.percentOfBudget ?? 0} tone={(week.percentOfBudget ?? 0) > 80 ? 'critical' : 'positive'} />
                <span className="body-sm" style={{ color: 'rgba(242,229,200,0.82)' }}>
                  {week.percentOfBudget}% of the {formatTokens(week.budgetTokens)} budget you set.
                </span>
              </>
            ) : (
              <span className="body-sm" style={{ color: 'rgba(242,229,200,0.82)' }}>
                No budget is set, so this is a count rather than a warning. The engine does not report the account
                limit, so nothing here can know it.
              </span>
            )}
            {week && week.unrecordedRuns > 0 ? (
              <span className="body-sm" style={{ color: 'rgba(242,229,200,0.82)' }}>
                {week.unrecordedRuns} run(s) recorded nothing, so this is a floor rather than a total.
              </span>
            ) : null}
          </Card>

          {usage ? (
            <Card>
              <span className="meta">Last 24 hours</span>
              <span className="kv-value" style={{ textAlign: 'left' }}>
                {formatTokensExact(usage.window.totalTokens)} tokens over {usage.window.runs} run(s)
              </span>
              {usage.window.byAgent.map((agent) => (
                <div className="kv" key={agent.agentType}>
                  <span className="kv-key">{agent.agentType}</span>
                  <span className="kv-value">{formatTokens(agent.totalTokens)}</span>
                </div>
              ))}
            </Card>
          ) : null}

          {queue && queue.entries.length > 0 ? (
            <Card>
              <span className="meta">Next in the queue</span>
              {queue.entries.slice(0, 4).map((entry) => (
                <div className="kv" key={entry.id}>
                  <span className="kv-key">{entry.projectName ?? '—'}</span>
                  <span className="kv-value">{jobLabel(entry.jobType)}</span>
                </div>
              ))}
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
