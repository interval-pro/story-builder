'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, type ReviewNote, type ReviewVersion, type SectionDiff, type Task } from '../../../lib/api';
import { RiskBadge, StateBadge } from '../../../components/state-badge';
import { ReviewView } from '../../../components/review-view';
import { ExecutionView } from '../../../components/execution-view';
import { FinalReportView } from '../../../components/final-report-view';

interface TaskDetail {
  task: Task;
  story: { id: string; title: string };
  revision: { revision: number; body: string };
  runs: { id: string; phase: string; agentType: string; status: string; startedAt: string; finishedAt: string | null }[];
  qaRuns: { id: string; iteration: number; verdict: string; findings: { id: string; severity: string; category: string; summary: string; detail: string; file: string | null }[] }[];
  testRuns: { id: string; command: string; exitCode: number; passed: boolean; createdAt: string }[];
  conflicts: { id: string; kind: string; severity: string; resource: string; description: string }[];
  sandbox: { id: string; status: string; mode: string; workspacePath: string } | null;
  activeJob: { id: string; jobType: string; status: string; attempt: number } | null;
  changes: { filePath: string; changeType: string; insertions: number; deletions: number }[];
}

interface ReviewPayload {
  review: { id: string } | null;
  versions: ReviewVersion[];
  notes: ReviewNote[];
  diff: SectionDiff[];
  current: ReviewVersion | null;
}

type Tab = 'review' | 'execution' | 'final';

export default function TaskPage() {
  const params = useParams<{ id: string }>();
  const taskId = params.id;
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [tab, setTab] = useState<Tab>('review');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detailResult, reviewResult] = await Promise.all([
        api.get<TaskDetail>(`/api/tasks/${taskId}`),
        api.get<ReviewPayload>(`/api/tasks/${taskId}/review`),
      ]);
      setDetail(detailResult);
      setReview(reviewResult);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [taskId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!detail) return;
    if (detail.task.state === 'FINAL_REVIEW_READY' || detail.task.state === 'COMPLETED' || detail.task.state === 'PR_CREATED') {
      setTab('final');
    } else if (['IMPLEMENTING', 'FIXING', 'QA_RUNNING', 'QA_QUEUED', 'IMPLEMENTATION_QUEUED', 'INTEGRATION_VALIDATION', 'PUSHING'].includes(detail.task.state)) {
      setTab('execution');
    }
  }, [detail?.task.state]);

  async function act(path: string) {
    setBusy(true);
    try {
      await api.post(`/api/tasks/${taskId}/${path}`, {});
      await load();
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : String(actError));
    } finally {
      setBusy(false);
    }
  }

  if (error && !detail) return <p className="error">{error}</p>;
  if (!detail) return <p className="empty">Loading...</p>;

  const { task } = detail;
  const canAnnotate = task.state === 'REVIEW_READY';

  return (
    <div>
      <div className="card-row">
        <div>
          <h2>{detail.story.title}</h2>
          <div className="meta">
            revision {detail.revision.revision} · branch {task.branchName} · base {task.baseBranch} @{' '}
            {task.baseCommit.slice(0, 10)}
            {task.baseMoved ? ' · base moved' : ''}
          </div>
        </div>
        <div className="row">
          <RiskBadge level={task.riskLevel} />
          <StateBadge state={task.state} />
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {task.blockedReason ? (
        <div className="card" style={{ borderColor: 'var(--amber)' }}>
          <strong>Blocked</strong>
          <p>{task.blockedReason}</p>
          <div className="row">
            <button className="secondary" disabled={busy} onClick={() => void act('unblock')}>
              Send back to implementation
            </button>
          </div>
        </div>
      ) : null}

      {task.state === 'FAILED' ? (
        <div className="card" style={{ borderColor: 'var(--red)' }}>
          <strong>This task failed</strong>
          <p>{task.failureReason ?? 'No reason was recorded.'}</p>
          <p className="meta">Retrying continues from what already completed rather than starting over.</p>
          <button disabled={busy} onClick={() => void act('retry')}>
            Retry
          </button>
        </div>
      ) : null}

      {task.state === 'HIGH_RISK_CONFIRMATION_REQUIRED' ? (
        <div className="card" style={{ borderColor: 'var(--amber)' }}>
          <strong>This change is high risk</strong>
          <p>The approved review needs a second, explicit execution approval before any code is written.</p>
          <button disabled={busy} onClick={() => void act('high-risk/confirm')}>
            Confirm execution
          </button>
        </div>
      ) : null}

      <div className="tabs">
        <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>
          Engineering review
        </button>
        <button className={tab === 'execution' ? 'active' : ''} onClick={() => setTab('execution')}>
          Execution
        </button>
        <button className={tab === 'final' ? 'active' : ''} onClick={() => setTab('final')}>
          Final report
        </button>
      </div>

      {tab === 'review' ? (
        review?.current && review.review ? (
          <ReviewView
            taskId={taskId}
            reviewId={review.review.id}
            version={review.current}
            notes={review.notes}
            diff={review.diff}
            canAct={canAnnotate}
            onChanged={() => void load()}
          />
        ) : (
          <p className="empty">The review has not been generated yet.</p>
        )
      ) : null}

      {tab === 'execution' ? <ExecutionView taskId={taskId} detail={detail} onAction={() => void load()} /> : null}

      {tab === 'final' ? <FinalReportView taskId={taskId} task={task} onChanged={() => void load()} /> : null}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Story</h3>
        <div className="section-body">{detail.revision.body}</div>
      </div>
    </div>
  );
}
