const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      message = text;
    }
    throw new Error(message || `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
};

export interface Task {
  id: string;
  state: string;
  riskLevel: string | null;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  qaIteration: number;
  blockedReason: string | null;
  failureReason: string | null;
  baseMoved: boolean;
  kind: string;
  createdAt: string;
}

export interface Story {
  id: string;
  title: string;
  kind: string;
  currentRevision: number;
  createdAt: string;
  tasks: Task[];
}

export interface ReviewSection {
  key: string;
  title: string;
  body: string;
}

export interface ReviewDocument {
  summary: string;
  sections: ReviewSection[];
  implementationSteps: { order: number; title: string; detail: string; files: string[] }[];
  expectedFiles: string[];
  expectedSymbols: string[];
  riskSignals: { indicator: string; evidence: string }[];
  openQuestions: string[];
}

export interface ReviewVersion {
  id: string;
  version: number;
  document: ReviewDocument;
  markdown: string;
  createdAt: string;
}

export interface ReviewNote {
  id: string;
  sectionKey: string | null;
  anchorText: string;
  note: string;
  status: string;
  createdAt: string;
}

export interface SectionDiff {
  key: string;
  title: string;
  status: 'unchanged' | 'changed' | 'added' | 'removed';
  before: string;
  after: string;
}

/** Human readable label for each lifecycle state. */
export const STATE_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  ANALYSIS_QUEUED: 'Analysis queued',
  ANALYZING: 'Researching the repository',
  REVIEW_READY: 'Engineering review ready',
  REVIEW_FEEDBACK_RECEIVED: 'Notes received',
  REVIEW_REGENERATING: 'Regenerating the review',
  REVIEW_APPROVED: 'Review approved',
  HIGH_RISK_CONFIRMATION_REQUIRED: 'High risk: execution approval required',
  IMPLEMENTATION_QUEUED: 'Implementation queued',
  IMPLEMENTING: 'Implementing',
  QA_QUEUED: 'QA queued',
  QA_RUNNING: 'QA running',
  FIX_REQUIRED: 'Fix required',
  FIXING: 'Fixing',
  BLOCKED: 'Blocked, needs a decision',
  FINAL_REVIEW_READY: 'Final report ready',
  PR_APPROVAL_REQUIRED: 'Pull request approval required',
  INTEGRATION_VALIDATION: 'Integration validation',
  PUSHING: 'Pushing',
  PR_CREATED: 'Pull request created',
  COMPLETED: 'Completed',
  WAITING_FOR_TASK: 'Waiting for another task',
  PAUSING: 'Pausing',
  PAUSED: 'Paused',
  STOPPING: 'Stopping',
  STOPPED: 'Stopped',
  FAILED: 'Failed',
  ROLLING_BACK: 'Rolling back',
  ROLLED_BACK: 'Rolled back',
};

export function stateTone(state: string): 'waiting' | 'running' | 'done' | 'attention' {
  if (['COMPLETED', 'PR_CREATED'].includes(state)) return 'done';
  if (['BLOCKED', 'FAILED', 'HIGH_RISK_CONFIRMATION_REQUIRED', 'FIX_REQUIRED', 'STOPPED'].includes(state)) return 'attention';
  if (state.endsWith('_QUEUED') || ['PAUSED', 'DRAFT', 'WAITING_FOR_TASK'].includes(state)) return 'waiting';
  return 'running';
}
