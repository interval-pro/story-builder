'use client';

import { useEffect, useState } from 'react';
import { api, type Task } from '../lib/api';
import { Button, Card, Empty, ErrorText } from './ui';
import { useAction } from './use-action';

/**
 * The report, and the one decision that follows it.
 *
 * Planned against actual is computed rather than narrated, so this is the one
 * document in the system that cannot flatter the work.
 */
export function ReportView({ taskId, task, onChanged }: { taskId: string; task: Task; onChanged: () => Promise<void> }) {
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const action = useAction();

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

  function approve() {
    void action.run('approve', 'Approving the pull request', async () => {
      await api.post(`/api/tasks/${taskId}/pull-request/approve`);
      await onChanged();
    });
  }

  return (
    <div className="stack">
      {error ? <ErrorText>{error}</ErrorText> : null}
      {action.error ? <ErrorText>{action.error}</ErrorText> : null}

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
            <Button onClick={approve} disabled={action.busy} pending={action.pending === 'approve'}>
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
