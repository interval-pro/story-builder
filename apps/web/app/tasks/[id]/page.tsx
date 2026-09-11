'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, type Project, type ReviewNote, type ReviewVersion, type SectionDiff, type Task } from '../../../lib/api';
import { RiskBadge, StateBadge } from '../../../components/state-badge';
import { ReviewView } from '../../../components/review-view';
import { ExecutionView } from '../../../components/execution-view';
import { FinalReportView } from '../../../components/final-report-view';

interface InstallationApply {
  id: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';
  step: string;
  log: string;
  candidateRef: string;
  startedAt: string;
  finishedAt: string | null;
}

interface TaskDetail {
  task: Task;
  project: Project;
  applies: InstallationApply[];
  story: { id: string; title: string };
  revision: { revision: number; body: string };
  runs: {
    id: string;
    phase: string;
    agentType: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    // Null means never recorded, which is not the same as free.
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    costUsd: number | null;
  }[];
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
  const applyingRef = useRef(false);
  const taskId = params.id;
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [tab, setTab] = useState<Tab>('review');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detailResult, reviewResult] = await Promise.all([
        api.get<TaskDetail>(`/api/tasks/${taskId}`),
        api.get<ReviewPayload>(`/api/tasks/${taskId}/review`),
      ]);
      setDetail(detailResult);
      setReview(reviewResult);
      setError(null);
      setUnreachable(false);
    } catch (loadError) {
      // While a candidate is being applied the API is deliberately down, so a
      // failed poll is expected rather than an error worth showing.
      if (applyingRef.current) setUnreachable(true);
      else setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [taskId]);

  useEffect(() => {
    applyingRef.current = applying;
  }, [applying]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  // The apply is finished when the API answers again and the record is no
  // longer running. Until then the page simply keeps trying.
  useEffect(() => {
    if (!applying || !detail) return;
    const latest = detail.applies[0];
    if (latest && latest.status !== 'RUNNING') setApplying(false);
  }, [applying, detail]);

  useEffect(() => {
    if (!detail) return;
    if (detail.task.state === 'FINAL_REVIEW_READY' || detail.task.state === 'COMPLETED' || detail.task.state === 'PR_CREATED') {
      setTab('final');
    } else if (['IMPLEMENTING', 'FIXING', 'QA_RUNNING', 'QA_QUEUED', 'IMPLEMENTATION_QUEUED', 'INTEGRATION_VALIDATION', 'PUSHING'].includes(detail.task.state)) {
      setTab('execution');
    }
  }, [detail?.task.state]);

  async function applyCandidate() {
    const confirmed = window.confirm(
      'Applying stops the whole system: the cockpit, the API, the orchestrator and the worker.\n\n' +
        'It then merges this task, rebuilds, migrates, runs the tests and starts everything again. ' +
        'This takes a few minutes and the page will be unreachable while it happens.\n\n' +
        'If anything fails the previous version is restored automatically.\n\nApply it now?',
    );
    if (!confirmed) return;
    setApplying(true);
    setUnreachable(false);
    try {
      await api.post(`/api/tasks/${taskId}/apply`, {});
    } catch (applyError) {
      setApplying(false);
      setError(applyError instanceof Error ? applyError.message : String(applyError));
    }
  }

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
  if (!detail) return <p className="empty">Reading this task and its engineering review.</p>;

  const latestApply = detail.applies[0] ?? null;
  const activeElsewhere = Boolean(detail.activeJob);

  const { task } = detail;
  const canAnnotate = task.state === 'REVIEW_READY';

  return (
    <div>
      <div className="card-row">
        <div>
          <h2>{detail.story.title}</h2>
          <div className="card-detail">
            revision {detail.revision.revision} · branch {task.branchName} · base {task.baseBranch} @{' '}
            {task.baseCommit.slice(0, 10)}
            {task.baseMoved ? ' · base moved' : ''}
          </div>
        </div>
        <div className="row">
          <RiskBadge level={task.riskLevel} />
          <StateBadge state={task.state} prominent />
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {task.blockedReason ? (
        <div className="card warning">
          <div className="card-value">Blocked</div>
          <p>{task.blockedReason}</p>
          <div className="actions">
            <button className="secondary" disabled={busy} onClick={() => void act('unblock')}>
              Send back to implementation
            </button>
          </div>
        </div>
      ) : null}

      {task.state === 'FAILED' ? (
        <div className="card critical">
          <div className="card-value">This task failed</div>
          <p>{task.failureReason ?? 'No reason was recorded.'}</p>
          <p className="card-detail">Retrying continues from what already completed rather than starting over.</p>
          <div className="actions">
            <button disabled={busy} onClick={() => void act('retry')}>
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {task.state === 'HIGH_RISK_CONFIRMATION_REQUIRED' ? (
        <div className="card warning">
          <div className="card-value">This change is high risk</div>
          <p>The approved review needs a second, explicit execution approval before any code is written.</p>
          <div className="actions">
            <button disabled={busy} onClick={() => void act('high-risk/confirm')}>
              Confirm execution
            </button>
          </div>
        </div>
      ) : null}

      {detail.project.kind === 'INSTALLATION' && task.state === 'COMPLETED' ? (
        <div className="card warning">
          <div className="card-value">Ready to apply to the engine</div>
          <p>
            This work is on branch {task.branchName} inside the installation. Nothing was pushed anywhere. Applying it
            stops every service, merges, rebuilds, migrates, runs the tests and starts everything again.
          </p>
          {latestApply?.status === 'RUNNING' || applying ? (
            <>
              <p className="card-detail">
                {unreachable
                  ? 'The system is restarting. This page will come back on its own.'
                  : `Applying: ${latestApply?.step ?? 'starting'}`}
              </p>
              <div className="actions">
                <button disabled>Applying...</button>
              </div>
            </>
          ) : (
            <>
              {latestApply?.status === 'ROLLED_BACK' || latestApply?.status === 'FAILED' ? (
                <p className="error">
                  The last attempt did not finish and the previous version was restored. Reason:{' '}
                  {latestApply.log.trim().split('\n').slice(-1)[0]}
                </p>
              ) : null}
              {latestApply?.status === 'SUCCEEDED' ? (
                <p className="card-detail">Applied at {new Date(latestApply.finishedAt ?? '').toLocaleString()}.</p>
              ) : null}
              <div className="actions">
                <button disabled={busy || activeElsewhere} onClick={() => void applyCandidate()}>
                  Apply to the engine and restart
                </button>
              </div>
              {activeElsewhere ? (
                <p className="card-detail">Other tasks are still running. Applying waits until nothing is in flight.</p>
              ) : null}
            </>
          )}
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
        <h3>Story</h3>
        <div className="section-body">{detail.revision.body}</div>
      </div>
    </div>
  );
}
