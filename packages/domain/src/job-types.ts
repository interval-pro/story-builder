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
  'SANDBOX_TEARDOWN',
  /** Turns an idea into one or more story drafts, asking questions on the way. */
  'IDEA_INTAKE',
  /** One turn of a chat session, in the project directory. */
  'CHAT_TURN',
  /** Everything a newly added project needs before a story can run against it. */
  'PROJECT_SETUP',
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
];

export function consumesAgentSlot(jobType: JobType): boolean {
  return SLOT_JOBS.includes(jobType);
}

/** Jobs that belong to a project rather than to one of its tasks. */
const PROJECT_JOBS: readonly JobType[] = ['PROJECT_SETUP', 'KNOWLEDGE_REFRESH', 'IDEA_INTAKE'];

export function isProjectJob(jobType: JobType): boolean {
  return PROJECT_JOBS.includes(jobType);
}
