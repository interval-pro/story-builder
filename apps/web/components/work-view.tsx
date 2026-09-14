'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Button, Card, Empty, ErrorText, KeyValue, Loading } from './ui';
import { useAction } from './use-action';
import { formatStamp, relativeAge } from '../lib/format';
import { loadPhase } from '../lib/load-state';

interface ToolCall {
  id: string;
  toolName: string;
  status: string;
  outputSummary: string;
  durationMs: number;
  createdAt: string;
}

interface Props {
  taskId: string;
  detail: {
    task: { state: string; qaIteration: number; baseMoved: boolean; branchName: string; baseCommit: string };
    project: { repoPath: string; workBranch: string };
    activeJob: { jobType: string; status: string; attempt: number } | null;
    changes: { filePath: string; changeType: string; insertions: number; deletions: number }[];
    testRuns: { id: string; command: string; exitCode: number; passed: boolean; createdAt: string }[];
  };
  onAction: () => Promise<void>;
}

/**
 * What the agents are actually doing, and what they have touched.
 *
 * The controls live here rather than in the header because they are about the
 * work rather than about the story: pausing a story means pausing whatever step
 * is running in it.
 */
export function WorkView({ taskId, detail, onAction }: Props) {
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const action = useAction();
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const result = await api.get<{ toolCalls: ToolCall[] }>(`/api/tasks/${taskId}/tool-calls?limit=30`);
        setToolCalls(result.toolCalls);
        setLoadedFor(taskId);
        setError(null);
      } catch (loadError) {
        // A failed poll keeps the calls already read rather than claiming none were made.
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [taskId]);

  function act(path: 'pause' | 'resume' | 'stop', label: string) {
    return action.run(path, label, async () => {
      await api.post(`/api/tasks/${taskId}/${path}`);
      await onAction();
    });
  }

  const insertions = detail.changes.reduce((total, change) => total + change.insertions, 0);
  const deletions = detail.changes.reduce((total, change) => total + change.deletions, 0);
  const phase = loadPhase({ key: taskId, loadedFor, error });

  return (
    <div className="stack">
      <Card>
        <div className="row-between">
          <div className="col">
            <span className="meta">Right now</span>
            <span className="list-title">
              {detail.activeJob
                ? `${detail.activeJob.jobType.toLowerCase().replace(/_/g, ' ')} · ${detail.activeJob.status.toLowerCase()}`
                : 'Nothing is running'}
            </span>
            {detail.activeJob && detail.activeJob.attempt > 1 ? (
              <span className="meta">attempt {detail.activeJob.attempt}</span>
            ) : null}
          </div>
          <div className="row">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void act('pause', 'Pausing')}
              disabled={action.busy}
              pending={action.pending === 'pause'}
            >
              Pause
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void act('resume', 'Resuming')}
              disabled={action.busy}
              pending={action.pending === 'resume'}
            >
              Resume
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void act('stop', 'Stopping')}
              disabled={action.busy}
              pending={action.pending === 'stop'}
            >
              Stop
            </Button>
          </div>
        </div>
        {action.error ? <ErrorText>{action.error}</ErrorText> : null}
      </Card>

      <div className="split">
        <div className="wide stack">
          <Card>
            <div className="row-between">
              <span className="meta">Files changed</span>
              <span className="meta">
                {detail.changes.length} file(s) · +{insertions} −{deletions}
              </span>
            </div>
            {detail.changes.length === 0 ? (
              <Empty>Nothing has been written yet. Files appear here as the agent writes them.</Empty>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Change</th>
                      <th>Lines</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.changes.map((change) => (
                      <tr key={change.filePath}>
                        <td className="mono">{change.filePath}</td>
                        <td>{change.changeType}</td>
                        <td className="num">
                          +{change.insertions} −{change.deletions}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <span className="meta">Latest tool activity</span>
            {phase === 'loading' ? (
              <Loading label="Reading the tool activity" rows={2} />
            ) : phase === 'failed' ? (
              <Empty>The tool activity could not be read. {error}</Empty>
            ) : toolCalls.length === 0 ? (
              <Empty>No tool has been called yet. This fills in while an agent works.</Empty>
            ) : (
              <div className="log">
                {toolCalls.map((call) => (
                  <div key={call.id}>
                    <span className="log-time">{formatStamp(call.createdAt)}</span>{' '}
                    {call.status === 'OK' ? '' : `[${call.status}] `}
                    {call.toolName} {call.outputSummary.slice(0, 160)}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="narrow stack">
          <Card>
            <span className="meta">Where the work happens</span>
            <KeyValue label="Branch">{detail.task.branchName}</KeyValue>
            <KeyValue label="Base">{detail.task.baseCommit.slice(0, 10)}</KeyValue>
            <KeyValue label="Directory">{detail.project.repoPath}</KeyValue>
            <KeyValue label="Goes back to">{detail.project.workBranch}</KeyValue>
            <KeyValue label="Fix cycles">{detail.task.qaIteration}</KeyValue>
            {detail.task.baseMoved ? (
              <span className="body-sm" style={{ color: 'var(--ochre-500)' }}>
                The base branch has moved since this started. It will be rebased before anything is pushed.
              </span>
            ) : null}
          </Card>

          <Card>
            <span className="meta">Tests</span>
            {detail.testRuns.length === 0 ? (
              <Empty>No test has run yet.</Empty>
            ) : (
              detail.testRuns
                .slice(-8)
                .reverse()
                .map((run) => (
                  <div className="kv" key={run.id}>
                    <span className="kv-key">{relativeAge(run.createdAt)}</span>
                    <span className="kv-value">
                      <Badge tone={run.passed ? 'done' : 'critical'}>{run.passed ? 'passed' : 'failed'}</Badge>
                      <div className="mono" style={{ marginTop: 6 }}>
                        {run.command}
                      </div>
                    </span>
                  </div>
                ))
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
