import type { ExecutionPhase } from './capabilities';
import type { QaRun, TaskRun } from './entities';
import type { TaskState } from './task-state';

/**
 * Where a task has got to, as a list of steps rather than a single state name.
 *
 * A state name tells a person nothing about what happened before it or what is
 * left. This derives the whole walk from the rows that already exist: the runs
 * say when each phase started and finished, the QA runs say how many times it
 * came back, and the state says which step the task is sitting in now.
 *
 * It is pure, so the cockpit and the tests see the same answer, and it lives in
 * the domain rather than in the cockpit so the CLI can show the same walk.
 */
export type StepStatus = 'PENDING' | 'RUNNING' | 'WAITING' | 'DONE' | 'BLOCKED' | 'FAILED' | 'SKIPPED';

export interface TaskStep {
  key: string;
  label: string;
  /** What this step is for, in one plain sentence. */
  purpose: string;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Null while the step has not started. Measured to the clock passed in. */
  durationMs: number | null;
  /** What it produced, or what it is waiting for. */
  detail: string;
  /** The runs that belong to this step, so usage can be read against it. */
  runIds: string[];
  /** True when a person has to act before this step can finish. */
  needsYou: boolean;
}

export interface TaskProgress {
  steps: TaskStep[];
  /** Index into steps, or -1 when the task has not started or is finished. */
  currentIndex: number;
  /** Whole-number percentage of steps finished. */
  percent: number;
  /** How long the task has been in its current step. */
  currentForMs: number | null;
  /** Total wall-clock time from the first run to the last finish, or to now. */
  elapsedMs: number | null;
}

interface StepSpec {
  key: string;
  label: string;
  purpose: string;
  /** The phase whose runs belong to this step, when it is agent work. */
  phase?: ExecutionPhase;
  /** States that mean the task is sitting in this step. */
  states: TaskState[];
  /** States in which this step is waiting for a person. */
  humanStates?: TaskState[];
  /**
   * True for a step whose work is commands rather than an agent session, so it
   * never leaves a run row behind. Without this, a finished story reported the
   * rebase and the push as skipped, because the only evidence the walk looks for
   * is a run — and those two steps produce none however much they do.
   */
  leavesNoRun?: true;
}

const SPECS: StepSpec[] = [
  {
    key: 'research',
    label: 'Research',
    purpose: 'Reads the repository and establishes what is actually there.',
    phase: 'RESEARCH',
    states: ['ANALYSIS_QUEUED', 'ANALYZING'],
  },
  {
    key: 'review',
    label: 'Plan',
    purpose: 'Turns the findings into one recommended approach.',
    phase: 'REVIEW',
    states: ['REVIEW_FEEDBACK_RECEIVED', 'REVIEW_REGENERATING'],
  },
  {
    key: 'approval',
    label: 'Your approval',
    purpose: 'Nothing is written until you approve the plan.',
    states: ['REVIEW_READY', 'HIGH_RISK_CONFIRMATION_REQUIRED'],
    humanStates: ['REVIEW_READY', 'HIGH_RISK_CONFIRMATION_REQUIRED'],
  },
  {
    key: 'implementation',
    label: 'Implementation',
    purpose: 'Writes the change in its own worktree, nowhere near your checkout.',
    phase: 'IMPLEMENTATION',
    states: ['REVIEW_APPROVED', 'IMPLEMENTATION_QUEUED', 'IMPLEMENTING', 'FIX_REQUIRED', 'FIXING', 'WAITING_FOR_TASK'],
  },
  {
    key: 'qa',
    label: 'Checks',
    purpose: 'A second agent reviews the diff and runs the tests, without seeing the reasoning.',
    phase: 'QA',
    states: ['QA_QUEUED', 'QA_RUNNING'],
  },
  {
    key: 'report',
    label: 'Report',
    purpose: 'Planned against actual, computed rather than narrated.',
    phase: 'FINAL_REPORT',
    states: [],
  },
  {
    key: 'pr_approval',
    label: 'Your decision',
    purpose: 'Whether this becomes a pull request.',
    states: ['FINAL_REVIEW_READY'],
    humanStates: ['FINAL_REVIEW_READY'],
  },
  {
    key: 'integration',
    label: 'Integration',
    purpose: 'Rebases onto the current base and re-runs the checks on the result.',
    phase: 'INTEGRATION',
    states: ['PR_APPROVAL_REQUIRED', 'INTEGRATION_VALIDATION'],
    leavesNoRun: true,
  },
  {
    key: 'push',
    label: 'Push',
    purpose: 'The only step that touches the remote, and only after your approval.',
    phase: 'PUSH',
    states: ['PUSHING', 'PR_CREATED'],
    leavesNoRun: true,
  },
];

function earliest(values: (string | null)[]): string | null {
  const times = values.filter((value): value is string => Boolean(value)).sort();
  return times[0] ?? null;
}

function latest(values: (string | null)[]): string | null {
  const times = values.filter((value): value is string => Boolean(value)).sort();
  return times[times.length - 1] ?? null;
}

function millisBetween(from: string | null, to: string | null, now: number): number | null {
  if (!from) return null;
  const start = Date.parse(from);
  if (!Number.isFinite(start)) return null;
  const end = to ? Date.parse(to) : now;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export interface ProgressInput {
  state: TaskState;
  qaIteration: number;
  blockedReason: string | null;
  failureReason: string | null;
  runs: Pick<TaskRun, 'id' | 'phase' | 'status' | 'startedAt' | 'finishedAt'>[];
  qaRuns: Pick<QaRun, 'iteration' | 'verdict' | 'findings'>[];
  /** True once the engineering review has been approved. */
  reviewApproved: boolean;
  /** Blocking decisions still open on the current review version. */
  openBlockingDecisions: number;
  /** Files the implementation has changed so far. */
  changedFiles: number;
  /**
   * The state the task was in before it was interrupted.
   *
   * A failure is attributed to this rather than to the last step that left a run
   * row behind. The push writes no run of its own, so a task that failed in the
   * push was being blamed on the checks — the last step that did.
   */
  previousState?: TaskState | null;
  now?: number;
}

/**
 * The step the task is in, by state.
 *
 * An interruption is not a step of its own: a paused task is paused inside
 * whatever it was doing, so the walk keeps showing that step and the cockpit
 * shows the interruption beside it.
 */
function currentSpecIndex(input: ProgressInput): number {
  const state = input.state;
  const direct = SPECS.findIndex((spec) => spec.states.includes(state));
  if (direct !== -1) return direct;
  if (state === 'COMPLETED') return SPECS.length;
  if (state === 'DRAFT') return -1;

  // Interrupted. The state it was interrupted from is the honest answer, and it is
  // recorded on the task: the push leaves no run row of its own, so blaming the
  // last step that did leaves a failed push showing up against the checks.
  if (input.previousState) {
    const fromPrevious = SPECS.findIndex((spec) => spec.states.includes(input.previousState!));
    if (fromPrevious !== -1) return fromPrevious;
  }

  const lastWithRun = SPECS.reduce(
    (found, spec, index) => (spec.phase && input.runs.some((run) => run.phase === spec.phase) ? index : found),
    -1,
  );
  return lastWithRun;
}

/** What a step should say about itself once it is done. */
function detailFor(spec: StepSpec, input: ProgressInput, runIds: string[]): string {
  switch (spec.key) {
    case 'qa': {
      const last = input.qaRuns[input.qaRuns.length - 1];
      if (!last) return '';
      const open = last.findings.length;
      return `Iteration ${last.iteration}: ${last.verdict.toLowerCase()}${open > 0 ? `, ${open} finding(s)` : ''}`;
    }
    case 'implementation':
      return input.changedFiles > 0 ? `${input.changedFiles} file(s) changed` : '';
    case 'approval':
      if (input.openBlockingDecisions > 0) {
        return `${input.openBlockingDecisions} decision(s) must be answered first`;
      }
      return input.reviewApproved ? 'Approved' : '';
    case 'review':
      // Runs, not versions: a review that failed and was retried is two runs and
      // one version, and calling that "2 versions" would invent a history.
      return runIds.length > 1 ? `${runIds.length} attempts` : '';
    default:
      return '';
  }
}

export function deriveTaskProgress(input: ProgressInput): TaskProgress {
  const now = input.now ?? Date.now();
  const currentIndex = currentSpecIndex(input);
  const interrupted = ['BLOCKED', 'FAILED', 'STOPPED', 'STOPPING', 'PAUSED', 'PAUSING', 'ROLLING_BACK', 'ROLLED_BACK'];
  const isInterrupted = interrupted.includes(input.state);

  const steps: TaskStep[] = SPECS.map((spec, index) => {
    const runs = spec.phase ? input.runs.filter((run) => run.phase === spec.phase) : [];
    const runIds = runs.map((run) => run.id);
    const startedAt = earliest(runs.map((run) => run.startedAt));
    const finishedAt = runs.some((run) => run.status === 'RUNNING')
      ? null
      : latest(runs.map((run) => run.finishedAt));

    let status: StepStatus;
    if (index < currentIndex) {
      // Behind the current step. A step with no run of its own was skipped rather
      // than done, except for the ones that never leave a run in the first place:
      // the rebase and the push do their work with commands and git.
      status = runs.length > 0 || !spec.phase || spec.leavesNoRun ? 'DONE' : 'SKIPPED';
    } else if (index > currentIndex) {
      // Ahead of where the task is now, but it may already have run: a fix cycle
      // sends the task back, so the checks are behind it in time and in front of
      // it in the walk. Reporting that step as "not yet" would throw away the
      // iteration that did happen.
      status = runs.length > 0 ? 'DONE' : 'PENDING';
    } else if (isInterrupted) {
      status = input.state === 'FAILED' ? 'FAILED' : input.state === 'BLOCKED' ? 'BLOCKED' : 'WAITING';
    } else if (spec.humanStates?.includes(input.state)) {
      status = 'WAITING';
    } else if (runs.some((run) => run.status === 'RUNNING')) {
      status = 'RUNNING';
    } else if (runs.some((run) => run.status === 'FAILED') && runs.every((run) => run.status !== 'COMPLETED')) {
      status = 'FAILED';
    } else {
      status = 'RUNNING';
    }

    // The approval step is done the moment the review was approved, whatever the
    // task went on to do afterwards.
    if (spec.key === 'approval' && input.reviewApproved && index <= currentIndex && !spec.humanStates?.includes(input.state)) {
      status = 'DONE';
    }

    const needsYou = status === 'WAITING' || status === 'BLOCKED';
    const detail = status === 'PENDING' ? '' : detailFor(spec, input, runIds);


    return {
      key: spec.key,
      label: spec.label,
      purpose: spec.purpose,
      status,
      startedAt,
      finishedAt,
      durationMs: millisBetween(startedAt, finishedAt, now),
      detail: isInterrupted && index === currentIndex ? (input.blockedReason ?? input.failureReason ?? detail) : detail,
      runIds,
      needsYou,
    };
  });

  const done = steps.filter((step) => step.status === 'DONE' || step.status === 'SKIPPED').length;
  const firstStart = earliest(input.runs.map((run) => run.startedAt));
  const allFinished = input.state === 'COMPLETED' || input.state === 'STOPPED' || input.state === 'ROLLED_BACK';
  const lastFinish = allFinished ? latest(input.runs.map((run) => run.finishedAt)) : null;
  const current = currentIndex >= 0 && currentIndex < steps.length ? steps[currentIndex] : undefined;

  return {
    steps,
    currentIndex: currentIndex >= steps.length ? -1 : currentIndex,
    percent: Math.round((done / steps.length) * 100),
    currentForMs: current ? millisBetween(current.startedAt, null, now) : null,
    elapsedMs: millisBetween(firstStart, lastFinish, now),
  };
}
