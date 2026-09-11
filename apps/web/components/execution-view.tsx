'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatTokens, formatUsd } from '../lib/format';

interface Props {
  taskId: string;
  detail: {
    task: { state: string; qaIteration: number; baseMoved: boolean };
    runs: {
      id: string;
      phase: string;
      agentType: string;
      status: string;
      startedAt: string;
      finishedAt: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheCreationTokens: number | null;
      costUsd: number | null;
      sessionId: string | null;
      // Null means never recorded, which is what an engine without sessions
      // leaves behind. It is not the same as a deliberate cold start.
      resumed: boolean | null;
      effort: string | null;
      model: string | null;
    }[];
    qaRuns: { id: string; iteration: number; verdict: string; findings: { id: string; severity: string; category: string; summary: string; detail: string; file: string | null }[] }[];
    testRuns: { id: string; command: string; exitCode: number; passed: boolean; createdAt: string }[];
    conflicts: { id: string; kind: string; severity: string; resource: string; description: string }[];
    sandbox: { id: string; status: string; mode: string; workspacePath: string } | null;
    activeJob: { id: string; jobType: string; status: string; attempt: number } | null;
    changes: { filePath: string; changeType: string; insertions: number; deletions: number }[];
  };
  onAction: () => void;
}

interface ToolCall {
  id: string;
  toolName: string;
  status: string;
  outputSummary: string;
  durationMs: number;
  createdAt: string;
}

type Run = Props['detail']['runs'][number];

interface AgentSpend {
  agentType: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  unrecordedRuns: number;
  failedRuns: number;
  /** Runs that continued an earlier session rather than reading it all again. */
  resumedRuns: number;
}

/**
 * Adds up what the task has spent, per agent and in total.
 *
 * A run with no recorded cost contributes nothing and is counted instead, so an
 * incomplete sum is never presented as a complete one. Cache reads are kept
 * beside the input count rather than folded into it: they bill at a fraction of
 * the price, and one combined number would look plausible and be wrong.
 *
 * Failed runs are counted here too, and separately, because a run that spent
 * thirty thousand tokens and then failed is exactly the spend worth seeing.
 */
function summariseSpend(runs: Run[]): { byAgent: AgentSpend[]; total: AgentSpend; unrecorded: number } {
  const empty = (agentType: string): AgentSpend => ({
    agentType,
    runs: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    unrecordedRuns: 0,
    failedRuns: 0,
    resumedRuns: 0,
  });

  const byAgent = new Map<string, AgentSpend>();
  const total = empty('total');

  for (const run of runs) {
    const agent = byAgent.get(run.agentType) ?? empty(run.agentType);
    for (const bucket of [agent, total]) {
      bucket.runs += 1;
      bucket.costUsd += run.costUsd ?? 0;
      bucket.inputTokens += run.inputTokens ?? 0;
      bucket.outputTokens += run.outputTokens ?? 0;
      bucket.cacheReadTokens += run.cacheReadTokens ?? 0;
      bucket.cacheCreationTokens += run.cacheCreationTokens ?? 0;
      if (run.costUsd === null) bucket.unrecordedRuns += 1;
      if (run.status === 'FAILED') bucket.failedRuns += 1;
      if (run.resumed === true) bucket.resumedRuns += 1;
    }
    byAgent.set(run.agentType, agent);
  }

  return { byAgent: [...byAgent.values()], total, unrecorded: total.unrecordedRuns };
}

/** Live view of what the agents are doing right now. */
export function ExecutionView({ taskId, detail, onAction }: Props) {
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const result = await api.get<{ toolCalls: ToolCall[] }>(`/api/tasks/${taskId}/tool-calls?limit=25`);
        setToolCalls(result.toolCalls);
      } catch {
        setToolCalls([]);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [taskId]);

  async function act(path: string) {
    setBusy(true);
    try {
      await api.post(`/api/tasks/${taskId}/${path}`, {});
      onAction();
    } finally {
      setBusy(false);
    }
  }

  const currentRun = detail.runs.find((run) => run.status === 'RUNNING');
  const latestQa = detail.qaRuns[detail.qaRuns.length - 1];
  const spend = summariseSpend(detail.runs);

  return (
    <div>
      <div className="card">
        <div className="card-row">
          <div>
            <div className="card-label">Current agent</div>
            <div className="card-value">{currentRun ? `${currentRun.agentType} (${currentRun.phase})` : 'idle'}</div>
            <div className="card-detail">
              job: {detail.activeJob ? `${detail.activeJob.jobType} · ${detail.activeJob.status} · attempt ${detail.activeJob.attempt}` : 'none'}
            </div>
            <div className="card-detail">
              sandbox: {detail.sandbox ? `${detail.sandbox.status} · ${detail.sandbox.mode}` : 'not created'}
            </div>
            <div className="card-detail">
              QA iteration {detail.task.qaIteration}
              {detail.task.baseMoved ? ' · the base branch has moved' : ''}
            </div>
          </div>
          <div className="row">
            <button className="secondary" disabled={busy} onClick={() => void act('pause')}>
              Pause
            </button>
            <button className="secondary" disabled={busy} onClick={() => void act('resume')}>
              Resume
            </button>
            <button className="danger" disabled={busy} onClick={() => void act('stop')}>
              Stop
            </button>
          </div>
        </div>
      </div>

      {detail.conflicts.length > 0 ? (
        <div className="card warning">
          <h3>Conflicts with other tasks</h3>
          <div className="table-scroll">
            <table>
              <tbody>
                {detail.conflicts.map((conflict) => (
                  <tr key={conflict.id}>
                    <td className="col-sm">{conflict.severity}</td>
                    <td className="col-lg">{conflict.resource}</td>
                    <td>{conflict.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {latestQa ? (
        <div className="card">
          <h3>
            QA iteration {latestQa.iteration}: {latestQa.verdict}
          </h3>
          {latestQa.findings.length === 0 ? (
            <p className="empty">QA found nothing to fix in this iteration.</p>
          ) : (
            latestQa.findings.map((finding) => (
              <div key={finding.id} className="note">
                <strong>
                  [{finding.severity}/{finding.category}] {finding.summary}
                </strong>
                <div>{finding.detail}</div>
                {finding.file ? <div className="meta">{finding.file}</div> : null}
              </div>
            ))
          )}
        </div>
      ) : null}

      <div className="card">
        <div className="card-label">What this task has spent</div>
        <div className="card-value">{formatUsd(spend.total.costUsd)}</div>
        <div className="card-detail">
          {formatTokens(spend.total.inputTokens)} in · {formatTokens(spend.total.outputTokens)} out ·{' '}
          {formatTokens(spend.total.cacheReadTokens)} cache read · {formatTokens(spend.total.cacheCreationTokens)} cache
          written
        </div>
        <div className="card-detail">
          Cost per run is measured: it is the figure the engine itself reports. This total sums the runs that recorded
          one.
        </div>
        {spend.unrecorded > 0 ? (
          <div className="card-detail">
            {spend.unrecorded} of {detail.runs.length} run(s) recorded no cost, so this total is partial.
          </div>
        ) : null}
        {spend.total.failedRuns > 0 ? (
          <div className="card-detail">
            {spend.total.failedRuns} of {detail.runs.length} run(s) failed, and what they spent is counted here.
          </div>
        ) : null}
        <div className="card-detail">
          {spend.total.resumedRuns} of {detail.runs.length} run(s) continued an earlier session instead of reading the
          repository again.
        </div>

        {spend.byAgent.length === 0 ? (
          <p className="empty">No run has reported what it spent yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <tbody>
                {spend.byAgent.map((agent) => (
                  <tr key={agent.agentType}>
                    <td className="col-md">{agent.agentType}</td>
                    <td className="col-sm">{agent.unrecordedRuns === agent.runs ? 'not recorded' : formatUsd(agent.costUsd)}</td>
                    <td className="meta">
                      {agent.runs} run(s) · {formatTokens(agent.inputTokens)} in ·{' '}
                      {formatTokens(agent.outputTokens)} out · {formatTokens(agent.cacheReadTokens)} cache read
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-scroll">
          <table>
            <tbody>
              {detail.runs.map((run) => (
                <tr key={run.id}>
                  <td className="col-md">
                    {run.agentType} ({run.phase})
                  </td>
                  <td className="col-sm">{run.costUsd === null ? 'not recorded' : formatUsd(run.costUsd)}</td>
                  <td className="meta">
                    {formatTokens(run.inputTokens ?? 0)} in · {formatTokens(run.outputTokens ?? 0)} out ·{' '}
                    {formatTokens(run.cacheReadTokens ?? 0)} cache read ·{' '}
                    {formatTokens(run.cacheCreationTokens ?? 0)} cache written
                    {run.resumed === null ? '' : run.resumed ? ' · resumed' : ' · started cold'}
                    {run.effort ? ` · ${run.effort} effort` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>Tests</h3>
        {detail.testRuns.length === 0 ? (
          <p className="empty">No tests have run yet. They start once there is something to check.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <tbody>
                {detail.testRuns.slice(-8).reverse().map((run) => (
                  <tr key={run.id}>
                    <td className="col-xs">
                      <span className={`badge ${run.passed ? 'done' : 'attention'}`}>{run.passed ? 'passed' : 'failed'}</span>
                    </td>
                    <td>{run.command}</td>
                    <td className="meta col-md">{new Date(run.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Changed files ({detail.changes.length})</h3>
        {detail.changes.length === 0 ? (
          <p className="empty">No files have been touched yet. Changes appear here as the agent writes them.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <tbody>
                {detail.changes.map((change) => (
                  <tr key={change.filePath}>
                    <td className="col-xs">{change.changeType}</td>
                    <td className="meta col-sm">
                      +{change.insertions} -{change.deletions}
                    </td>
                    <td>{change.filePath}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Latest tool activity</h3>
        {toolCalls.length === 0 ? (
          <p className="empty">No tools have been called yet. This fills in while an agent is working.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <tbody>
                {toolCalls.map((call) => (
                  <tr key={call.id}>
                    <td className="col-md">{call.toolName}</td>
                    <td className="col-xs">
                      <span className={`badge ${call.status === 'OK' ? 'done' : 'attention'}`}>{call.status}</span>
                    </td>
                    <td>{call.outputSummary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
