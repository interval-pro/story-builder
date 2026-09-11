/**
 * What the cockpit's own words mean, in plain language.
 *
 * Every state name in this system is jargon until someone explains it, and the
 * explanation has to be where the name is rather than in documentation nobody
 * opens. Each entry answers the only two questions a person actually has: what
 * has happened, and what happens next.
 */
export interface Explanation {
  /** A short name a person would use out loud. */
  label: string;
  /** What this means has happened. */
  means: string;
  /** What happens next, and whether it needs them. */
  next: string;
}

export type Tone = 'waiting' | 'running' | 'done' | 'caution' | 'critical';

const STATES: Record<string, Explanation & { tone: Tone }> = {
  DRAFT: {
    label: 'Draft',
    tone: 'waiting',
    means: 'The story exists but nothing has started on it.',
    next: 'Nothing happens until it is started.',
  },
  ANALYSIS_QUEUED: {
    label: 'Waiting to start',
    tone: 'waiting',
    means: 'The story is in the queue and will be picked up when a slot frees.',
    next: 'The research agent reads the repository. Nothing is written at this stage.',
  },
  ANALYZING: {
    label: 'Reading the code',
    tone: 'running',
    means: 'An agent is reading the repository to establish what is actually there.',
    next: 'It writes a plan, which you get to approve or correct.',
  },
  REVIEW_READY: {
    label: 'Plan ready for you',
    tone: 'waiting',
    means: 'There is a plan and nothing will be written until you approve it.',
    next: 'Read the short version, answer any decisions, then approve or leave notes.',
  },
  REVIEW_FEEDBACK_RECEIVED: {
    label: 'Your notes received',
    tone: 'running',
    means: 'Your notes on the plan have been recorded.',
    next: 'The plan is being rewritten to address them.',
  },
  REVIEW_REGENERATING: {
    label: 'Rewriting the plan',
    tone: 'running',
    means: 'The agent is rewriting the parts of the plan your notes affect.',
    next: 'You get a new version, with the changed sections marked.',
  },
  REVIEW_APPROVED: {
    label: 'Plan approved',
    tone: 'running',
    means: 'You approved the plan, so the task may now write code.',
    next: 'Implementation starts on this story\u2019s own branch in the project directory.',
  },
  HIGH_RISK_CONFIRMATION_REQUIRED: {
    label: 'High risk: confirm',
    tone: 'caution',
    means: 'The plan touches something risky, so approving it once is not enough.',
    next: 'Confirm explicitly, or leave notes and send it back.',
  },
  IMPLEMENTATION_QUEUED: {
    label: 'Waiting to be written',
    tone: 'waiting',
    means: 'Approved and in the queue, waiting for a slot.',
    next: 'An agent writes the change against the approved plan.',
  },
  IMPLEMENTING: {
    label: 'Writing the change',
    tone: 'running',
    means: 'An agent is writing the change on this story\u2019s own branch.',
    next: 'A second agent checks the diff and runs the tests.',
  },
  QA_QUEUED: {
    label: 'Waiting to be checked',
    tone: 'waiting',
    means: 'The change is written and waiting for a slot to be checked.',
    next: 'A separate agent reviews the diff without seeing the reasoning behind it.',
  },
  QA_RUNNING: {
    label: 'Being checked',
    tone: 'running',
    means: 'A second agent is reviewing the diff and running the tests.',
    next: 'Either it approves, or it sends findings back for a fix cycle.',
  },
  FIX_REQUIRED: {
    label: 'Fix needed',
    tone: 'caution',
    means: 'The checks found something, so the change goes back to be fixed.',
    next: 'The fix runs, then the checks run again. This repeats up to the configured limit.',
  },
  FIXING: {
    label: 'Fixing',
    tone: 'running',
    means: 'An agent is addressing the findings from the checks.',
    next: 'The checks run again on the result.',
  },
  BLOCKED: {
    label: 'Stuck, needs you',
    tone: 'critical',
    means: 'Something stopped that nothing automatic can resolve.',
    next: 'Read the reason, then choose which step it goes back to.',
  },
  FINAL_REVIEW_READY: {
    label: 'Finished, your decision',
    tone: 'waiting',
    means: 'The change is written and the checks passed.',
    next: 'Read the report and decide whether it becomes a pull request.',
  },
  PR_APPROVAL_REQUIRED: {
    label: 'Approved for a pull request',
    tone: 'running',
    means: 'You approved it, so the branch is being prepared.',
    next: 'It rebases onto the current base and re-runs the checks before anything is pushed.',
  },
  INTEGRATION_VALIDATION: {
    label: 'Rebasing and re-checking',
    tone: 'running',
    means: 'The branch is being rebased onto the current base and checked again on the result.',
    next: 'If it still passes, it is pushed. If not, it goes back for a fix.',
  },
  PUSHING: {
    label: 'Pushing',
    tone: 'running',
    means: 'The branch is being pushed. This is the only step that touches the remote.',
    next: 'A pull request is opened and the task is finished.',
  },
  PR_CREATED: {
    label: 'Pull request open',
    tone: 'done',
    means: 'The branch was pushed and a pull request exists.',
    next: 'Review and merge it yourself. This system never merges.',
  },
  COMPLETED: {
    label: 'Done here',
    tone: 'done',
    means: 'Everything this system does is finished: pushed, with a pull request open. It does not mean merged.',
    next: 'Merging is yours. Nothing else happens here.',
  },
  WAITING_FOR_TASK: {
    label: 'Waiting for another story',
    tone: 'waiting',
    means: 'Another story has to finish first, because they would collide.',
    next: 'This one starts on its own once the other is out of the way.',
  },
  PAUSING: {
    label: 'Pausing',
    tone: 'waiting',
    means: 'A pause was requested and is being applied.',
    next: 'It stops at the end of what it is doing.',
  },
  PAUSED: {
    label: 'Paused',
    tone: 'waiting',
    means: 'Paused by you. Nothing is running and nothing is lost.',
    next: 'Resume returns it to exactly the step it was in.',
  },
  STOPPING: {
    label: 'Stopping',
    tone: 'caution',
    means: 'A stop was requested and is being applied.',
    next: 'The work is committed, the directory goes back to your branch, and the story ends here.',
  },
  STOPPED: {
    label: 'Stopped',
    tone: 'done',
    means: 'Stopped by you. The branch, if there is one, is still on disk.',
    next: 'Nothing else happens. Start a new story if you want this done differently.',
  },
  FAILED: {
    label: 'Failed',
    tone: 'critical',
    means: 'A step failed outright, after its retries.',
    next: 'Retry continues from what already finished rather than starting over.',
  },
  ROLLING_BACK: {
    label: 'Rolling back',
    tone: 'caution',
    means: 'The change is being undone.',
    next: 'The repository returns to where it was.',
  },
  ROLLED_BACK: {
    label: 'Rolled back',
    tone: 'done',
    means: 'The change was undone and nothing of it remains.',
    next: 'Nothing else happens.',
  },
};

export function explainState(state: string): Explanation & { tone: Tone } {
  return (
    STATES[state] ?? {
      label: state.toLowerCase().replace(/_/g, ' '),
      tone: 'running',
      means: 'This state has no explanation written for it yet.',
      next: 'Nothing here can say what happens next.',
    }
  );
}

/** QA verdicts, which read as harsher than they are. */
const VERDICTS: Record<string, Explanation & { tone: Tone }> = {
  APPROVED: {
    label: 'Passed',
    tone: 'done',
    means: 'The checking agent found nothing it would reject the change for.',
    next: 'The report is written and the decision about a pull request is yours.',
  },
  REJECTED: {
    label: 'Sent back',
    tone: 'caution',
    means:
      'The checking agent found something it wants changed. This is the ordinary outcome of a first pass, not a verdict on the work.',
    next: 'The findings go back for a fix, then the checks run again.',
  },
  BLOCKED: {
    label: 'Needs you',
    tone: 'critical',
    means: 'The checking agent found something it cannot have fixed without changing what was approved.',
    next: 'It waits for you to decide, rather than widening the plan on its own.',
  },
};

export function explainVerdict(verdict: string): Explanation & { tone: Tone } {
  return (
    VERDICTS[verdict] ?? {
      label: verdict.toLowerCase(),
      tone: 'running',
      means: 'This verdict has no explanation written for it yet.',
      next: '',
    }
  );
}

const SEVERITY_TONES: Record<string, Tone> = {
  blocking: 'critical',
  high: 'critical',
  medium: 'caution',
  low: 'running',
};

export function severityTone(severity: string): Tone {
  return SEVERITY_TONES[severity] ?? 'running';
}

/** What each queue job type is, in words rather than in constants. */
const JOB_LABELS: Record<string, string> = {
  RESEARCH: 'Reading the code',
  REVIEW_GENERATE: 'Writing the plan',
  REVIEW_REGENERATE: 'Rewriting the plan',
  IMPLEMENTATION: 'Writing the change',
  FIX: 'Fixing what the checks found',
  QA: 'Checking the change',
  FINAL_REPORT: 'Writing the report',
  INTEGRATION_VALIDATION: 'Rebasing and re-checking',
  PUSH_AND_PR: 'Pushing and opening a pull request',
  LEARNING: 'Learning from your corrections',
  KNOWLEDGE_REFRESH: 'Re-reading the project',
  RUNTIME_MANIFEST: 'Working out how the project builds',
  RELEASE_DIRECTORY: 'Giving the project directory back',
  MERGE_STORY: 'Merging into the work branch',
  MERGE_RESOLVE: 'Trying the merge conflicts',
  IDEA_INTAKE: 'Shaping an idea into stories',
  CHAT_TURN: 'Answering in chat',
  PROJECT_SETUP: 'Preparing a new project',
};

export function jobLabel(jobType: string): string {
  return JOB_LABELS[jobType] ?? jobType.toLowerCase().replace(/_/g, ' ');
}

const STEP_TONES: Record<string, Tone> = {
  DONE: 'done',
  RUNNING: 'running',
  WAITING: 'waiting',
  BLOCKED: 'critical',
  FAILED: 'critical',
  PENDING: 'running',
  SKIPPED: 'running',
};

export function stepTone(status: string): Tone {
  return STEP_TONES[status] ?? 'running';
}

export function riskTone(level: string | null): Tone {
  if (level === 'HIGH') return 'critical';
  if (level === 'MEDIUM') return 'caution';
  return 'done';
}
