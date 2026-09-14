/**
 * Whether the AI is working on something now, or it is only waiting its turn.
 *
 * One rule for every screen, so the same story does not pulse on one page and sit
 * still on the next: pulse only while a worker holds the work, sit still while it
 * is queued, and show nothing when it is waiting for a person, stopped or done.
 *
 * The job or run status decides wherever there is one. The task state name cannot:
 * the orchestrator writes REVIEW_REGENERATING, and on a retry INTEGRATION_VALIDATION
 * and PUSHING, when it queues the job rather than when a worker starts it.
 */
export type Activity = 'working' | 'queued' | null;

/**
 * States where a person has to act. Copied from the domain rather than imported,
 * because the cockpit is a standalone application with no workspace dependencies.
 */
const HUMAN_GATE_STATES = [
  'REVIEW_READY',
  'HIGH_RISK_CONFIRMATION_REQUIRED',
  'BLOCKED',
  'FINAL_REVIEW_READY',
  'PR_APPROVAL_REQUIRED',
];

/**
 * Interruptions. A paused story's job may still be in the queue, but nothing about
 * it is going to start, so it shows no activity.
 */
const INTERRUPTION_STATES = ['PAUSING', 'PAUSED', 'STOPPING', 'STOPPED', 'FAILED', 'ROLLING_BACK', 'ROLLED_BACK'];

/** States that only ever mean the task is in the queue. */
const QUEUED_STATES = ['ANALYSIS_QUEUED', 'IMPLEMENTATION_QUEUED', 'QA_QUEUED', 'WAITING_FOR_TASK'];

/** States a worker writes when it starts, so they mean the work is happening. */
const WORKING_STATES = ['ANALYZING', 'IMPLEMENTING', 'FIXING', 'QA_RUNNING'];

export function jobActivity(status: string | null | undefined): Activity {
  if (status === 'RUNNING') return 'working';
  if (status === 'PENDING') return 'queued';
  return null;
}

export function runActivity(status: string | null | undefined): Activity {
  return status === 'RUNNING' ? 'working' : null;
}

export function ideaActivity(status: string | null | undefined): Activity {
  if (status === 'THINKING') return 'working';
  if (status === 'QUEUED') return 'queued';
  return null;
}

export function chatActivity(status: string | null | undefined): Activity {
  if (status === 'STREAMING') return 'working';
  if (status === 'PENDING') return 'queued';
  return null;
}

export function setupActivity(status: string | null | undefined): Activity {
  if (status === 'RUNNING') return 'working';
  if (status === 'PENDING') return 'queued';
  return null;
}

export function stepActivity(status: string | null | undefined): Activity {
  if (status === 'RUNNING') return 'working';
  if (status === 'QUEUED') return 'queued';
  return null;
}

/**
 * The status of each task's job in the queue feed, keyed by task.
 *
 * A task that is not in the feed is left out rather than recorded as having no
 * job: the feed is capped, so absence is not proof, and taskActivity falls back to
 * the state name for it.
 */
export function jobStatusesByTask(
  entries: readonly { taskId: string | null; status: string }[] | null | undefined,
): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const entry of entries ?? []) {
    if (!entry.taskId) continue;
    // A running job says more than a pending one behind it for the same task.
    if (statuses.get(entry.taskId) === 'RUNNING') continue;
    statuses.set(entry.taskId, entry.status);
  }
  return statuses;
}

/**
 * A task's activity, from its state and the status of its active job.
 *
 * `jobStatus` is null when the task is known to have no active job, and undefined
 * when that is not known — the queue feed failed, or the task is not in it — in
 * which case the state name is the best evidence left.
 */
export function taskActivity(state: string, jobStatus: string | null | undefined): Activity {
  if (HUMAN_GATE_STATES.includes(state) || INTERRUPTION_STATES.includes(state)) return null;
  if (jobStatus !== undefined && jobStatus !== null) return jobActivity(jobStatus);
  if (jobStatus === null) return state === 'WAITING_FOR_TASK' ? 'queued' : null;
  if (QUEUED_STATES.includes(state)) return 'queued';
  if (WORKING_STATES.includes(state)) return 'working';
  return null;
}
