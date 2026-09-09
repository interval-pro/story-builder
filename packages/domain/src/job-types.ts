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
