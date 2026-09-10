'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Props {
  taskId: string;
  detail: {
    task: { state: string; qaIteration: number; baseMoved: boolean };
    runs: { id: string; phase: string; agentType: string; status: string; startedAt: string; finishedAt: string | null }[];
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
