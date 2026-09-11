import { IllegalTransitionError } from '@ai-engine/shared';

/**
 * The lifecycle of a task. Only the orchestrator is allowed to move a task
 * between these states; agents and the API may only request transitions.
 */
export const TASK_STATES = [
  'DRAFT',
  'ANALYSIS_QUEUED',
  'ANALYZING',
  'REVIEW_READY',
  'REVIEW_FEEDBACK_RECEIVED',
  'REVIEW_REGENERATING',
  'REVIEW_APPROVED',
  'HIGH_RISK_CONFIRMATION_REQUIRED',
  'IMPLEMENTATION_QUEUED',
  'IMPLEMENTING',
  'QA_QUEUED',
  'QA_RUNNING',
  'FIX_REQUIRED',
  'FIXING',
  'BLOCKED',
  'FINAL_REVIEW_READY',
  'PR_APPROVAL_REQUIRED',
  'INTEGRATION_VALIDATION',
  'PUSHING',
  'PR_CREATED',
  'COMPLETED',
  'WAITING_FOR_TASK',
  'PAUSING',
  'PAUSED',
  'STOPPING',
  'STOPPED',
  'FAILED',
  'ROLLING_BACK',
  'ROLLED_BACK',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** States from which no further automatic progress happens. */
export const TERMINAL_STATES: readonly TaskState[] = ['COMPLETED', 'STOPPED', 'ROLLED_BACK'] as const;

/** States that represent a global interruption rather than lifecycle progress. */
export const INTERRUPTION_STATES: readonly TaskState[] = [
  'PAUSING',
  'PAUSED',
  'STOPPING',
  'STOPPED',
  'FAILED',
  'ROLLING_BACK',
  'ROLLED_BACK',
] as const;

/** States in which a human decision is required before the task can continue. */
export const HUMAN_GATE_STATES: readonly TaskState[] = [
  'REVIEW_READY',
  'HIGH_RISK_CONFIRMATION_REQUIRED',
  'BLOCKED',
  'FINAL_REVIEW_READY',
  'PR_APPROVAL_REQUIRED',
] as const;

/** States in which agents are allowed to write inside the task sandbox. */
export const WRITE_ENABLED_STATES: readonly TaskState[] = [
  'IMPLEMENTING',
  'FIXING',
  'INTEGRATION_VALIDATION',
  'PUSHING',
] as const;

const BASE_TRANSITIONS: Record<TaskState, TaskState[]> = {
  DRAFT: ['ANALYSIS_QUEUED'],
  ANALYSIS_QUEUED: ['ANALYZING'],
  ANALYZING: ['REVIEW_READY'],
  REVIEW_READY: ['REVIEW_FEEDBACK_RECEIVED', 'REVIEW_APPROVED', 'HIGH_RISK_CONFIRMATION_REQUIRED', 'ANALYSIS_QUEUED'],
  REVIEW_FEEDBACK_RECEIVED: ['REVIEW_REGENERATING'],
  REVIEW_REGENERATING: ['REVIEW_READY'],
  REVIEW_APPROVED: ['IMPLEMENTATION_QUEUED', 'HIGH_RISK_CONFIRMATION_REQUIRED', 'WAITING_FOR_TASK'],
  HIGH_RISK_CONFIRMATION_REQUIRED: ['IMPLEMENTATION_QUEUED', 'REVIEW_FEEDBACK_RECEIVED'],
  IMPLEMENTATION_QUEUED: ['IMPLEMENTING', 'WAITING_FOR_TASK'],
  IMPLEMENTING: ['QA_QUEUED', 'BLOCKED'],
  QA_QUEUED: ['QA_RUNNING'],
  QA_RUNNING: ['FINAL_REVIEW_READY', 'FIX_REQUIRED', 'BLOCKED'],
  FIX_REQUIRED: ['FIXING', 'BLOCKED'],
  FIXING: ['QA_QUEUED', 'BLOCKED'],
  // PUSHING and INTEGRATION_VALIDATION are here because a push that fails blocks
  // the task, and every other route out of BLOCKED re-runs an agent for work that
  // was already finished. Without them the only reachable end was STOPPED, which
  // meant pushing the branch by hand.
  BLOCKED: [
    'REVIEW_FEEDBACK_RECEIVED',
    'IMPLEMENTATION_QUEUED',
    'FIX_REQUIRED',
    'ANALYSIS_QUEUED',
    'INTEGRATION_VALIDATION',
    'PUSHING',
  ],
  FINAL_REVIEW_READY: ['PR_APPROVAL_REQUIRED', 'REVIEW_FEEDBACK_RECEIVED', 'FIX_REQUIRED'],
  PR_APPROVAL_REQUIRED: ['INTEGRATION_VALIDATION'],
  INTEGRATION_VALIDATION: ['PUSHING', 'FIX_REQUIRED', 'BLOCKED', 'COMPLETED'],
  // COMPLETED is reachable directly because not every finish goes through a pull
  // request. A project with no configured remote finishes on a local branch, and
  // an installation is never pushed at all: its work waits on a branch until
  // someone applies it. Both paths ended here and both threw
  // "Transition PUSHING -> COMPLETED is not allowed", which failed the task after
  // all of its work had succeeded.
  PUSHING: ['PR_CREATED', 'COMPLETED', 'BLOCKED'],
  PR_CREATED: ['COMPLETED'],
  COMPLETED: [],
  WAITING_FOR_TASK: ['ANALYSIS_QUEUED', 'IMPLEMENTATION_QUEUED', 'BLOCKED'],
  PAUSING: ['PAUSED'],
  PAUSED: [],
  STOPPING: ['STOPPED'],
  STOPPED: [],
  // Every state a retry can continue from. A task that failed after its pull
  // request was approved failed in the integration or in the push, and sending it
  // back to QA would re-run an agent over a diff that has already been checked
  // and approved.
  FAILED: [
    'ANALYSIS_QUEUED',
    'REVIEW_REGENERATING',
    'IMPLEMENTATION_QUEUED',
    'QA_QUEUED',
    'INTEGRATION_VALIDATION',
    'PUSHING',
    'ROLLING_BACK',
    'STOPPING',
  ],
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
  ROLLED_BACK: [],
};

/**
 * Interruptions can be requested from any non-terminal state, so they are
 * layered on top of the lifecycle graph instead of being repeated in it.
 */
function allowedTargets(from: TaskState): TaskState[] {
  const targets = new Set<TaskState>(BASE_TRANSITIONS[from]);
  if (!TERMINAL_STATES.includes(from)) {
    targets.add('PAUSING');
    targets.add('STOPPING');
    targets.add('FAILED');
  }
  if (from === 'PAUSED') {
    // Resume returns the task to the state it was paused from; the orchestrator
    // supplies that state explicitly, so every non-interruption state is legal.
    for (const state of TASK_STATES) {
      if (!INTERRUPTION_STATES.includes(state)) targets.add(state);
    }
    targets.add('STOPPING');
  }
  return [...targets];
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  if (from === to) return false;
  return allowedTargets(from).includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isHumanGate(state: TaskState): boolean {
  return HUMAN_GATE_STATES.includes(state);
}

export function allowsWorkspaceWrites(state: TaskState): boolean {
  return WRITE_ENABLED_STATES.includes(state);
}

export function transitionsFrom(state: TaskState): TaskState[] {
  return allowedTargets(state);
}
