export const JOB_TYPES = [
  'RESEARCH',
  'REVIEW_GENERATE',
  'REVIEW_REGENERATE',
  'IMPLEMENTATION',
  'QA',
  'FIX',
  'FINAL_REPORT',
  'INTEGRATION_VALIDATION',
  'PUSH_AND_PR',
  'LEARNING',
  'KNOWLEDGE_REFRESH',
  'RUNTIME_MANIFEST',
  'RELEASE_DIRECTORY',
  /** Turns an idea into one or more story drafts, asking questions on the way. */
  'IDEA_INTAKE',
  /** One turn of a chat session, in the project directory. */
  'CHAT_TURN',
  /** Everything a newly added project needs before a story can run against it. */
  'PROJECT_SETUP',
  /** Rebases a finished story onto the work branch, merges it, and pushes. */
  'MERGE_STORY',
  /** Lets an agent try the conflicts a merge stopped on. */
  'MERGE_RESOLVE',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobPayload {
  taskId: string;
  runId?: string;
  reason?: string;
  [key: string]: unknown;
}

/**
 * Whether a job occupies one of the global concurrency slots.
 *
 * The limit exists to bound how many heavy things run at once: agent sessions
 * and the build and test commands they need. Rendering a report, pushing a
 * branch or destroying a sandbox is not that, and a chat turn is a person
 * waiting at a keyboard, which must not queue behind a fix cycle.
 *
 * Stored on the job row as well, because the admission rule counts running
 * slots inside the same statement that claims the next job and cannot call in
 * here to ask.
 */
const SLOT_JOBS: readonly JobType[] = [
  'RESEARCH',
  'REVIEW_GENERATE',
  'REVIEW_REGENERATE',
  'IMPLEMENTATION',
  'QA',
  'FIX',
  'INTEGRATION_VALIDATION',
  'LEARNING',
  'IDEA_INTAKE',
  'MERGE_RESOLVE',
];

export function consumesAgentSlot(jobType: JobType): boolean {
  return SLOT_JOBS.includes(jobType);
}

/** Jobs that belong to a project rather than to one of its tasks. */
const PROJECT_JOBS: readonly JobType[] = ['PROJECT_SETUP', 'KNOWLEDGE_REFRESH', 'IDEA_INTAKE'];

export function isProjectJob(jobType: JobType): boolean {
  return PROJECT_JOBS.includes(jobType);
}

/**
 * Whether a job needs the project's working directory to itself.
 *
 * There are no worktrees any more: a story works in the project directory on a
 * branch of its own. Two jobs for one project would therefore be two agents
 * writing to one checkout, so the queue refuses the second until the first is
 * done. It is a different question from consumes_slot, which bounds how much runs
 * at once everywhere.
 *
 * A chat turn is the exception and holds nothing. It runs against whatever is
 * checked out, and when a story has the directory it answers read-only and says
 * so, which is more useful than making a person wait for a fix cycle.
 */
const DIRECTORY_JOBS: readonly JobType[] = [
  'RESEARCH',
  'REVIEW_GENERATE',
  'REVIEW_REGENERATE',
  'IMPLEMENTATION',
  'FIX',
  'QA',
  'FINAL_REPORT',
  'INTEGRATION_VALIDATION',
  'PUSH_AND_PR',
  'LEARNING',
  'RELEASE_DIRECTORY',
  'IDEA_INTAKE',
  'PROJECT_SETUP',
  'KNOWLEDGE_REFRESH',
  'RUNTIME_MANIFEST',
  'MERGE_STORY',
  'MERGE_RESOLVE',
];

export function holdsProjectDirectory(jobType: JobType): boolean {
  return DIRECTORY_JOBS.includes(jobType);
}
