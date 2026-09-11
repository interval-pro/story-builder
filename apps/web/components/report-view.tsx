'use client';

import { useEffect, useState } from 'react';
import { api, type Task } from '../lib/api';
import { Button, Card, Empty, ErrorText } from './ui';

/**
 * The report, and the one decision that follows it.
 *
 * Planned against actual is computed rather than narrated, so this is the one
 * document in the system that cannot flatter the work.
 */
export function ReportView({ taskId, task, onChanged }: { taskId: string; task: Task; onChanged: () => void }) {
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
      await api.post(`/api/tasks/${taskId}/pull-request/approve`);
      onChanged();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {error ? <ErrorText>{error}</ErrorText> : null}

      {task.state === 'FINAL_REVIEW_READY' ? (
        <Card>
          <div className="row-between">
            <div className="col">
              <span className="meta">Your decision</span>
              <span className="list-title">Does this become a pull request?</span>
              <span className="body-sm">
                Approving rebases the branch onto the current base, re-runs the checks on the result, and only then
                pushes. Nothing is merged: that stays yours.
              </span>
            </div>
            <Button onClick={() => void approve()} disabled={busy}>
              Approve and push
            </Button>
          </div>
        </Card>
      ) : null}

      {report ? (
        <Card>
          <span className="meta">Final report · computed, not narrated</span>
          <div className="log" style={{ maxHeight: 'none' }}>
            {report}
          </div>
        </Card>
      ) : (
        <Empty>The report is written once the checks pass. There is nothing to read yet.</Empty>
      )}
    </div>
  );
}
