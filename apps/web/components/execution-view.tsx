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
          <div className="stack">
            <div>
              <strong>Current agent:</strong> {currentRun ? `${currentRun.agentType} (${currentRun.phase})` : 'idle'}
            </div>
            <div className="meta">
              job: {detail.activeJob ? `${detail.activeJob.jobType} · ${detail.activeJob.status} · attempt ${detail.activeJob.attempt}` : 'none'}
            </div>
            <div className="meta">
              sandbox: {detail.sandbox ? `${detail.sandbox.status} · ${detail.sandbox.mode}` : 'not created'}
            </div>
            <div className="meta">
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
        <div className="card" style={{ borderColor: 'var(--amber)' }}>
          <h3 style={{ marginTop: 0 }}>Conflicts with other tasks</h3>
          <table>
            <tbody>
              {detail.conflicts.map((conflict) => (
                <tr key={conflict.id}>
                  <td style={{ width: 110 }}>{conflict.severity}</td>
                  <td style={{ width: 220 }}>{conflict.resource}</td>
                  <td>{conflict.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {latestQa ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            QA iteration {latestQa.iteration}: {latestQa.verdict}
          </h3>
          {latestQa.findings.length === 0 ? (
            <p className="meta">No findings.</p>
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
        <h3 style={{ marginTop: 0 }}>Tests</h3>
        {detail.testRuns.length === 0 ? (
          <p className="meta">No test runs recorded yet.</p>
        ) : (
          <table>
            <tbody>
              {detail.testRuns.slice(-8).reverse().map((run) => (
                <tr key={run.id}>
                  <td style={{ width: 90 }}>
                    <span className={`badge ${run.passed ? 'done' : 'attention'}`}>{run.passed ? 'passed' : 'failed'}</span>
                  </td>
                  <td>{run.command}</td>
                  <td className="meta" style={{ width: 180 }}>{new Date(run.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Changed files ({detail.changes.length})</h3>
        {detail.changes.length === 0 ? (
          <p className="meta">Nothing has been changed yet.</p>
        ) : (
          <table>
            <tbody>
              {detail.changes.map((change) => (
                <tr key={change.filePath}>
                  <td style={{ width: 100 }}>{change.changeType}</td>
                  <td style={{ width: 110 }} className="meta">
                    +{change.insertions} -{change.deletions}
                  </td>
                  <td>{change.filePath}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Latest tool activity</h3>
        {toolCalls.length === 0 ? (
          <p className="meta">No tool calls yet.</p>
        ) : (
          <table>
            <tbody>
              {toolCalls.map((call) => (
                <tr key={call.id}>
                  <td style={{ width: 170 }}>{call.toolName}</td>
                  <td style={{ width: 80 }}>
                    <span className={`badge ${call.status === 'OK' ? 'done' : 'attention'}`}>{call.status}</span>
                  </td>
                  <td>{call.outputSummary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
