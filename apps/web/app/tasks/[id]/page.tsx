'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  api,
  type Decision,
  type Project,
  type ReviewNote,
  type ReviewVersion,
  type SectionDiff,
  type Task,
  type TaskProgress,
} from '../../../lib/api';
import { Alert, Button, Card, Empty, ErrorText, StateBadge, Tabs } from '../../../components/ui';
import { StoryProgress } from '../../../components/story-progress';
import { PlanView } from '../../../components/plan-view';
import { WorkView } from '../../../components/work-view';
import { ChecksView } from '../../../components/checks-view';
import { ReportView } from '../../../components/report-view';
import { TimelineView } from '../../../components/timeline-view';
import { UsageView } from '../../../components/usage-view';
import { formatStamp, relativeAge } from '../../../lib/format';
import { explainState } from '../../../lib/labels';

interface InstallationApply {
  id: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';
  step: string;
  log: string;
  candidateRef: string;
  finishedAt: string | null;
}

interface TaskDetail {
  task: Task;
  project: Project;
  decisions: Decision[];
  openDecisions: Decision[];
  maxQaIterations: number;
  applies: InstallationApply[];
  story: { id: string; title: string };
  revision: { revision: number; body: string };
  qaRuns: { id: string; iteration: number; verdict: string; findings: never[]; notes?: never[] }[];
  testRuns: { id: string; command: string; exitCode: number; passed: boolean; createdAt: string }[];
  conflicts: { id: string; kind: string; severity: string; resource: string; description: string }[];
  activeJob: { jobType: string; status: string; attempt: number } | null;
  changes: { filePath: string; changeType: string; insertions: number; deletions: number }[];
}

interface ReviewPayload {
  review: { id: string } | null;
  versions: ReviewVersion[];
  notes: ReviewNote[];
  diff: SectionDiff[];
  decisions: Decision[];
  current: ReviewVersion | null;
}

type Tab = 'overview' | 'plan' | 'work' | 'checks' | 'report' | 'timeline' | 'usage';

/** Where a blocked story may be sent back to, in the order a person would try. */
const UNBLOCK_ROUTES: { target: string; label: string; help: string }[] = [
  {
    target: 'FIX_REQUIRED',
    label: 'Back to the fix cycle',
    help: 'Keeps the branch and the findings it was rejected on, and fixes from there.',
  },
  {
    target: 'PUSHING',
    label: 'Try the push again',
    help: 'For a push that failed. Nothing is rebuilt and no agent runs.',
  },
  {
    target: 'INTEGRATION_VALIDATION',
    label: 'Rebase and re-check',
    help: 'Rebases onto the current base and runs the checks again before pushing.',
  },
  {
    target: 'IMPLEMENTATION_QUEUED',
    label: 'Back to implementation',
    help: 'Writes the change again from the approved plan.',
  },
  {
    target: 'ANALYSIS_QUEUED',
    label: 'Back to the beginning',
    help: 'Reads the repository again and writes a new plan. The most expensive route.',
  },
];

export default function StoryPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const taskId = params.id;
  const applyingRef = useRef(false);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [tabPinned, setTabPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [detailResult, reviewResult, progressResult] = await Promise.all([
        api.get<TaskDetail>(`/api/tasks/${taskId}`),
        api.get<ReviewPayload>(`/api/tasks/${taskId}/review`),
        api.get<{ progress: TaskProgress }>(`/api/tasks/${taskId}/progress`),
      ]);
      setDetail(detailResult);
      setReview(reviewResult);
      setProgress(progressResult.progress);
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

  useEffect(() => {
    if (!applying || !detail) return;
    const latest = detail.applies[0];
    if (latest && latest.status !== 'RUNNING') setApplying(false);
  }, [applying, detail]);

  // The tab follows the story until the person picks one, after which it stays
  // where they put it. Moving the tab under someone reading is worse than
  // landing them on the wrong one.
  useEffect(() => {
    if (tabPinned || !detail) return;
    const state = detail.task.state;
    if (state === 'REVIEW_READY' || state === 'HIGH_RISK_CONFIRMATION_REQUIRED') setTab('plan');
    else if (state === 'FINAL_REVIEW_READY' || state === 'COMPLETED' || state === 'PR_CREATED') setTab('report');
    else setTab('overview');
  }, [detail, tabPinned]);

  async function act(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      await api.post(`/api/tasks/${taskId}/${path}`, body);
      await load();
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : String(actError));
    } finally {
      setBusy(false);
    }
  }

  async function applyCandidate() {
    const confirmed = window.confirm(
      'Applying stops the whole system: the cockpit, the API, the orchestrator and the worker.\n\n' +
        'It then merges this story, rebuilds, migrates, runs the tests and starts everything again. ' +
        'This takes a few minutes and the page will be unreachable while it happens.\n\n' +
        'If anything fails the previous version is restored automatically.\n\nApply it now?',
    );
    if (!confirmed) return;
    setApplying(true);
    setUnreachable(false);
    try {
      await api.post(`/api/tasks/${taskId}/apply`);
    } catch (applyError) {
      setApplying(false);
      setError(applyError instanceof Error ? applyError.message : String(applyError));
    }
  }

  if (error && !detail) return <div className="page"><ErrorText>{error}</ErrorText></div>;
  if (!detail) return <div className="page">Reading this story.</div>;

  const { task } = detail;
  const explanation = explainState(task.state);
  const latestApply = detail.applies[0] ?? null;
  const conflicted = detail.project.mergeConflictTaskId === task.id;
  const openDecisions = (review?.decisions ?? []).filter((decision) => decision.status === 'OPEN').length;

  return (
    <div className="page enter">
      <div>
        <span
          className="meta"
          onClick={() => router.push('/stories')}
          style={{ cursor: 'pointer', color: 'var(--text-accent)' }}
        >
          ← All stories
        </span>
        <div className="row-between" style={{ marginTop: 18 }}>
          <div className="grow">
            <div className="meta">
              {detail.project.name} · revision {detail.revision.revision} · opened {formatStamp(task.createdAt)} ·{' '}
              {task.branchName}
            </div>
            <h1 className="display" style={{ marginTop: 14 }}>
              {detail.story.title}
            </h1>
          </div>
          <div className="row" style={{ paddingTop: 6 }}>
            {task.riskLevel ? <span className="badge caution">{task.riskLevel} risk</span> : null}
            <StateBadge state={task.state} large />
          </div>
        </div>
        <p className="standfirst">
          {explanation.means} {explanation.next}
        </p>
      </div>

      {error ? <ErrorText>{error}</ErrorText> : null}

      {task.blockedReason ? (
        <Card>
          <Alert tone="critical" title="Stuck, and it needs you">
            {task.blockedReason}
          </Alert>

          {/* A block caused by work outside the approved plan comes with the
              questions that caused it. Answering them is the point; the routes
              below are what you do once they are answered. */}
          {(detail.openDecisions ?? []).map((decision) => (
            <div className="stack" key={decision.key}>
              <span className="meta">{decision.blocking ? 'Blocking decision' : 'Decision'}</span>
              <div className="prose" style={{ fontSize: 17 }}>
                {decision.question}
              </div>
              {decision.detail ? <span className="body-sm">{decision.detail}</span> : null}
              <div className="choices">
                {decision.options.map((option) => (
                  <button
                    key={option.key}
                    className="choice"
                    onClick={() => void act(`decisions/${decision.key}`, { chosenKey: option.key })}
                    disabled={busy}
                  >
                    {option.recommended ? <span className="choice-recommended">Recommended</span> : null}
                    <span className="choice-label">{option.label}</span>
                    {option.detail ? <span className="choice-detail">{option.detail}</span> : null}
                    {option.consequence ? (
                      <span className="choice-consequence">Costs: {option.consequence}</span>
                    ) : null}
                  </button>
                ))}
                <button
                  className="choice"
                  onClick={() => void act(`decisions/${decision.key}`, { chosenKey: 'agent' })}
                  disabled={busy}
                >
                  <span className="choice-label">Whatever you judge best</span>
                  <span className="choice-detail">The engineer chooses, knowing the options above.</span>
                </button>
              </div>
            </div>
          ))}

          <span className="meta">Where should it go back to?</span>
          <div className="choices">
            {UNBLOCK_ROUTES.map((route) => (
              <button
                key={route.target}
                className="choice"
                onClick={() => void act('unblock', { target: route.target })}
                disabled={busy}
              >
                <span className="choice-label">{route.label}</span>
                <span className="choice-detail">{route.help}</span>
              </button>
            ))}
          </div>
        </Card>
      ) : null}

      {task.state === 'FAILED' ? (
        <Card>
          <Alert tone="critical" title="This failed">
            {task.failureReason ?? 'No reason was recorded.'}
          </Alert>
          <span className="body-sm">
            Retrying continues from whatever already finished rather than starting over, and it keeps any notes you left
            on the plan.
          </span>
          <div className="row">
            <Button onClick={() => void act('retry')} disabled={busy}>
              Retry
            </Button>
            <Button variant="danger" onClick={() => void act('stop')} disabled={busy}>
              Stop it for good
            </Button>
          </div>
        </Card>
      ) : null}

      {task.state === 'HIGH_RISK_CONFIRMATION_REQUIRED' ? (
        <Card>
          <Alert tone="caution" title="High risk: confirm before anything is written">
            The plan touches something the risk check flagged, so approving it once is not enough.
          </Alert>
          <div className="row">
            <Button onClick={() => void act('high-risk/confirm')} disabled={busy}>
              Confirm and start
            </Button>
          </div>
        </Card>
      ) : null}

      {detail.conflicts.length > 0 ? (
        <Alert tone="caution" title="Conflicts with other stories">
          {detail.conflicts.map((conflict) => `${conflict.resource}: ${conflict.description}`).join(' · ')}
        </Alert>
      ) : null}

      {detail.project.kind === 'PROJECT' && task.state === 'COMPLETED' && !task.mergedAt && !conflicted ? (
        <Card>
          <span className="meta">Ready to merge</span>
          <span className="body-sm">
            The work is on {task.branchName}. Merging rebases it onto {detail.project.workBranch} first, so the merge
            itself is usually silent, and records where {detail.project.workBranch} was beforehand so this can be undone
            with one action.{' '}
            {detail.project.remoteAccess === 'WRITE'
              ? 'It is pushed afterwards, because the token grants write access.'
              : 'It stays local, because the token does not grant write access to the remote.'}
          </span>
          <div className="row">
            <Button onClick={() => void act('merge', { action: 'merge' })} disabled={busy}>
              Merge into {detail.project.workBranch}
            </Button>
          </div>
        </Card>
      ) : null}

      {conflicted ? (
        <Card>
          <Alert tone="caution" title="The merge stopped on conflicts">
            {(task.mergeConflictFiles ?? []).length > 0
              ? `Git stopped on ${(task.mergeConflictFiles ?? []).join(', ')}.`
              : 'Git stopped on a conflict.'}{' '}
            The conflict is sitting in {detail.project.repoPath} exactly as git left it, so you can open it in your
            editor. Nothing else will run in that directory until this is settled.
          </Alert>
          <span className="body-sm">
            Resolving it yourself is the sensible default. A conflict is the one place where an automatic resolution is
            at its most dangerous: both sides usually compile, and choosing wrongly produces a change that quietly does
            half of what two people meant.
          </span>
          <div className="row">
            <Button onClick={() => void act('merge', { action: 'continue' })} disabled={busy}>
              I resolved it, carry on
            </Button>
            <Button variant="secondary" onClick={() => void act('merge', { action: 'resolve' })} disabled={busy}>
              Let the engineer try
            </Button>
            <Button variant="ghost" onClick={() => void act('merge', { action: 'abort' })} disabled={busy}>
              Abandon the merge
            </Button>
          </div>
        </Card>
      ) : null}

      {task.mergedAt ? (
        <Card>
          <span className="meta">Merged {relativeAge(task.mergedAt)}</span>
          <span className="body-sm">
            This story is in {detail.project.workBranch}. Undoing puts that branch back to{' '}
            {task.mergeUndoCommit?.slice(0, 10)}, which is where it was immediately before the merge. It refuses if
            anything has been committed there since.
          </span>
          <div className="row">
            <Button variant="ghost" onClick={() => void act('merge', { action: 'undo' })} disabled={busy}>
              Undo the merge
            </Button>
          </div>
        </Card>
      ) : null}

      {detail.project.kind === 'INSTALLATION' && task.state === 'COMPLETED' ? (
        <Card>
          <span className="meta">Ready to apply to the engine</span>
          <span className="body-sm">
            This work is on branch {task.branchName} inside the installation and nothing was pushed anywhere. Applying
            stops every service, merges, rebuilds, migrates, runs the tests and starts everything again.
          </span>
          {latestApply?.status === 'RUNNING' || applying ? (
            <>
              <span className="meta">
                {unreachable
                  ? 'The system is restarting. This page comes back on its own.'
                  : `Applying: ${latestApply?.step ?? 'starting'}`}
              </span>
              <div className="row">
                <Button disabled>Applying…</Button>
              </div>
            </>
          ) : (
            <>
              {latestApply?.status === 'ROLLED_BACK' || latestApply?.status === 'FAILED' ? (
                <ErrorText>
                  The last attempt did not finish and the previous version was restored.{' '}
                  {latestApply.log.trim().split('\n').slice(-1)[0]}
                </ErrorText>
              ) : null}
              {latestApply?.status === 'SUCCEEDED' ? (
                <span className="meta">Applied {relativeAge(latestApply.finishedAt)}</span>
              ) : null}
              <div className="row">
                <Button onClick={() => void applyCandidate()} disabled={busy}>
                  Apply it and restart
                </Button>
              </div>
            </>
          )}
        </Card>
      ) : null}

      <Tabs<Tab>
        active={tab}
        onChange={(key) => {
          setTab(key);
          setTabPinned(true);
        }}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'plan', label: 'Plan', count: openDecisions },
          { key: 'work', label: 'Work' },
          { key: 'checks', label: 'Checks', count: detail.qaRuns.length },
          { key: 'report', label: 'Report' },
          { key: 'timeline', label: 'Timeline' },
          { key: 'usage', label: 'Usage' },
        ]}
      />

      {tab === 'overview' ? (
        <div className="stack">
          {progress ? <StoryProgress progress={progress} /> : <Empty>Working out where this has got to.</Empty>}
          <Card>
            <span className="meta">The story, as you wrote it</span>
            <div className="prose">{detail.revision.body}</div>
          </Card>
        </div>
      ) : null}

      {tab === 'plan' ? (
        review?.current && review.review ? (
          <PlanView
            taskId={taskId}
            reviewId={review.review.id}
            version={review.current}
            notes={review.notes}
            diff={review.diff}
            decisions={review.decisions}
            canAct={task.state === 'REVIEW_READY'}
            onChanged={() => void load()}
          />
        ) : (
          <Empty>No plan has been written yet. The research pass has to finish first.</Empty>
        )
      ) : null}

      {tab === 'work' ? <WorkView taskId={taskId} detail={detail} onAction={() => void load()} /> : null}

      {tab === 'checks' ? (
        <ChecksView qaRuns={detail.qaRuns} maxIterations={detail.maxQaIterations ?? 5} />
      ) : null}

      {tab === 'report' ? <ReportView taskId={taskId} task={task} onChanged={() => void load()} /> : null}

      {tab === 'timeline' ? <TimelineView taskId={taskId} /> : null}

      {tab === 'usage' ? <UsageView taskId={taskId} /> : null}
    </div>
  );
}
