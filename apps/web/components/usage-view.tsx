'use client';

import { useEffect, useState } from 'react';
import { api, type TaskUsage } from '../lib/api';
import { Badge, Card, Empty, Tile } from './ui';
import { formatDuration, formatStamp, formatTokens, formatTokensExact } from '../lib/format';

/**
 * What this story used, per run.
 *
 * Per run rather than only per agent, because the question a person has is which
 * run was the expensive one. An agent total hides a single implementation run that
 * was forty per cent of the whole story on its own, and that run is the thing
 * worth looking at.
 *
 * Nothing here is money. The account is a subscription with a weekly token limit,
 * so tokens are the unit that answers "how much of the week is gone".
 */
export function UsageView({ taskId }: { taskId: string }) {
  const [usage, setUsage] = useState<TaskUsage | null>(null);

  useEffect(() => {
    async function load() {
      try {
        setUsage(await api.get<TaskUsage>(`/api/tasks/${taskId}/usage`));
      } catch {
        setUsage(null);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [taskId]);

  if (!usage) return <Empty>Reading what this story used.</Empty>;

  const biggest = usage.byRun.reduce((largest, run) => (run.totalTokens > largest ? run.totalTokens : largest), 0);

  return (
    <div className="stack">
      <div className="tiles">
        <Tile value={formatTokens(usage.totalTokens)} label="Tokens in total" />
        <Tile value={usage.runs} label="Agent runs" />
        <Tile
          value={usage.unrecordedRuns}
          label="Runs that recorded nothing"
          tone={usage.unrecordedRuns > 0 ? 'attention' : undefined}
        />
        <Tile
          value={formatDuration(usage.byRun.reduce((total, run) => total + (run.durationMs ?? 0), 0))}
          label="Time in agents"
        />
      </div>

      {usage.unrecordedRuns > 0 ? (
        <Card tone="plain">
          <span className="meta">Why the total is a floor</span>
          <p className="body-sm">
            {usage.unrecordedRuns} of {usage.runs} run(s) recorded no usage at all, usually because they were killed
            before the engine printed its result. What they spent is real and missing from the number above.
          </p>
        </Card>
      ) : null}

      <Card>
        <span className="meta">By agent</span>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Runs</th>
                <th>Tokens</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {usage.byAgent.map((agent) => (
                <tr key={agent.agentType}>
                  <td>{agent.agentType}</td>
                  <td className="num">{agent.runs}</td>
                  <td className="num">{formatTokensExact(agent.tokens)}</td>
                  <td className="num">
                    {usage.totalTokens > 0 ? `${Math.round((agent.tokens / usage.totalTokens) * 100)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <span className="meta">Every run</span>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Started</th>
                <th>Took</th>
                <th>Tokens</th>
                <th>Cache read</th>
                <th>Cache written</th>
                <th>Session</th>
              </tr>
            </thead>
            <tbody>
              {usage.byRun.map((run) => (
                <tr key={run.id}>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <span>{run.agentType}</span>
                      {run.status === 'FAILED' ? <Badge tone="critical">failed</Badge> : null}
                      {run.status === 'RUNNING' ? <Badge tone="waiting">running</Badge> : null}
                      {run.totalTokens === biggest && biggest > 0 ? <Badge tone="caution">largest</Badge> : null}
                    </div>
                    {run.errorMessage ? (
                      <div className="body-sm" style={{ color: 'var(--ink-critical)' }}>
                        {run.errorMessage.split('\n')[0]?.slice(0, 140)}
                      </div>
                    ) : null}
                  </td>
                  <td className="num">{formatStamp(run.startedAt)}</td>
                  <td className="num">{formatDuration(run.durationMs)}</td>
                  <td className="num">
                    {run.inputTokens === null && run.outputTokens === null
                      ? 'not recorded'
                      : formatTokensExact(run.totalTokens)}
                  </td>
                  <td className="num">{formatTokens(run.cacheReadTokens ?? 0)}</td>
                  <td className="num">{formatTokens(run.cacheCreationTokens ?? 0)}</td>
                  <td>
                    {/* Null is "never recorded", which is not the same statement
                        as a deliberate cold start. Reporting the two as one thing
                        was a defect this cockpit shipped once. */}
                    {run.resumed === null ? 'not recorded' : run.resumed ? 'continued' : 'started cold'}
                    {run.effort ? ` · ${run.effort}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card tone="plain">
        <span className="meta">How to read this</span>
        <p className="body-sm">
          Cache read and cache written are where almost all of the usage is: a long session is re-read on every turn, so
          a conversation allowed to grow to the size of the window costs far more than the thinking in it. A run marked
          largest is the one worth looking at if a story cost more than it should have.
        </p>
      </Card>
    </div>
  );
}
