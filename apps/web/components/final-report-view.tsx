'use client';

import { useEffect, useState } from 'react';
import { api, type Task } from '../lib/api';

export function FinalReportView({ taskId, task, onChanged }: { taskId: string; task: Task; onChanged: () => void }) {
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const result = await api.get<{ report: string | null }>(`/api/tasks/${taskId}/final-report`);
        setReport(result.report);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void load();
  }, [taskId, task.state]);

  async function approve() {
    setBusy(true);
    try {
      await api.post(`/api/tasks/${taskId}/pull-request/approve`, {});
      onChanged();
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : String(approveError));
    } finally {
      setBusy(false);
    }
  }

  if (!report) return <p className="empty">The final report has not been produced yet.</p>;

  return (
    <div>
      {task.state === 'FINAL_REVIEW_READY' ? (
        <div className="card">
          <div className="card-row">
            <div>
              <div className="card-value">Ready for your decision</div>
              <div className="card-detail">
                Approving rebases the branch onto the current base, re-runs the checks and only then pushes.
              </div>
            </div>
            <div className="actions">
              <button disabled={busy} onClick={() => void approve()}>
                Approve and create pull request
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      <div className="card">
        <pre>{report}</pre>
      </div>
    </div>
  );
}
