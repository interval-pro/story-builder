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
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/**
 * The cockpit keeps its own copy of these shapes rather than importing the
 * domain package.
 *
 * It is a standalone Next application on purpose: its build traces only itself,
 * which is what keeps a cockpit rebuild from walking the whole monorepo. The cost
 * is this file, and the cost is worth paying.
 */
export interface Project {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  remoteUrl: string | null;
  kind: 'PROJECT' | 'INSTALLATION';
  description: string | null;
  setupState: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';
  setupError: string | null;
  createdAt: string;
  taskCounts?: Record<string, number>;
  knowledgeSnapshot?: { sequence: number; gitCommit: string } | null;
  runtimeManifest?: { version: number; validated: boolean } | null;
}

export interface Task {
  id: string;
  projectId: string;
  storyId: string;
  state: string;
  riskLevel: string | null;
  size: string | null;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  qaIteration: number;
  blockedReason: string | null;
  failureReason: string | null;
  baseMoved: boolean;
  createdAt: string;
  updatedAt: string;
  projectName?: string;
  storyTitle?: string;
}

export interface Story {
  id: string;
  title: string;
  currentRevision: number;
  createdAt: string;
  tasks: Task[];
}

export interface StoryDraft {
  id: string;
  projectId: string;
  sessionId: string | null;
  title: string;
  body: string;
  rationale: string;
  sequence: number;
  status: 'DRAFT' | 'LAUNCHED' | 'DISCARDED';
  taskId: string | null;
  createdAt: string;
}

export interface IdeaOption {
  key: string;
  label: string;
  detail: string;
}

export interface IdeaQuestion {
  id: string;
  round: number;
  sequence: number;
  question: string;
  rationale: string;
  options: IdeaOption[];
  chosenKey: string | null;
  customAnswer: string | null;
  answeredAt: string | null;
}

export interface IdeaSession {
  id: string;
  projectId: string;
  idea: string;
  status: 'QUEUED' | 'THINKING' | 'ASKING' | 'READY' | 'FAILED' | 'DISCARDED';
  understanding: string | null;
  round: number;
  error: string | null;
  createdAt: string;
}

export interface ReviewBrief {
  headline: string;
  approach: string;
  changes: string[];
  watchOut: string[];
  effort: string;
}

export interface ReviewSection {
  key: string;
  title: string;
  body: string;
}

export interface ReviewDocument {
  summary: string;
  brief: ReviewBrief | null;
  sections: ReviewSection[];
  implementationSteps: { order: number; title: string; detail: string; files: string[] }[];
  expectedFiles: string[];
  expectedSymbols: string[];
  riskSignals: { indicator: string; evidence: string }[];
  openQuestions: string[];
  decisions: unknown[];
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

export interface DecisionOption {
  key: string;
  label: string;
  detail: string;
  consequence: string;
  recommended: boolean;
}

export interface Decision {
  id: string;
  key: string;
  question: string;
  detail: string;
  blocking: boolean;
  options: DecisionOption[];
  status: 'OPEN' | 'ANSWERED';
  chosenKey: string | null;
  customAnswer: string | null;
  answeredAt: string | null;
}

export interface QueueEntry {
  id: string;
  jobType: string;
  status: string;
  position: string;
  consumesSlot: boolean;
  heldAt: string | null;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  lockedAt: string | null;
  lastError: string | null;
  taskId: string | null;
  taskState: string | null;
  projectId: string | null;
  projectName: string | null;
  storyTitle: string | null;
}

export interface WaitingTask {
  taskId: string;
  projectId: string;
  projectName: string;
  storyTitle: string;
  state: string;
  since: string;
  openDecisions: number;
  blockedReason: string | null;
}

export interface QueueView {
  entries: QueueEntry[];
  waiting: WaitingTask[];
  policy: { concurrency: number; paused: boolean; runningSlots: number };
  running: number;
  pending: number;
}

export interface TaskStep {
  key: string;
  label: string;
  purpose: string;
  status: 'PENDING' | 'RUNNING' | 'WAITING' | 'DONE' | 'BLOCKED' | 'FAILED' | 'SKIPPED';
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  detail: string;
  runIds: string[];
  needsYou: boolean;
}

export interface TaskProgress {
  steps: TaskStep[];
  currentIndex: number;
  percent: number;
  currentForMs: number | null;
  elapsedMs: number | null;
}

export interface RunUsage {
  id: string;
  phase: string;
  agentType: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number;
  resumed: boolean | null;
  effort: string | null;
  model: string | null;
  sessionId: string | null;
  errorMessage: string | null;
}

export interface TaskUsage {
  totalTokens: number;
  runs: number;
  unrecordedRuns: number;
  byAgent: { agentType: string; runs: number; tokens: number; unrecorded: number }[];
  byRun: RunUsage[];
}

export interface UsageView {
  window: {
    hours: number;
    since: string;
    until: string;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
    totalTokens: number;
    runs: number;
    unrecordedRuns: number;
    failedRuns: number;
    byAgent: { agentType: string; runs: number; totalTokens: number; unrecordedRuns: number; failedRuns: number }[];
  };
  week: {
    since: string;
    until: string;
    usedTokens: number;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
    runs: number;
    unrecordedRuns: number;
    budgetTokens: number | null;
    percentOfBudget: number | null;
    reportedLimit: Record<string, unknown> | null;
  };
  provenance: { perRun: string; window: string; limit: string };
}

export interface SettingDescriptor {
  key: string;
  label: string;
  help: string;
  kind: 'text' | 'secret' | 'integer' | 'boolean' | 'choice';
  defaultValue: string;
  choices?: { value: string; label: string; help: string }[];
  min?: number;
  max?: number;
  group: string;
  value: string;
  isSet: boolean;
  source: 'stored' | 'environment' | 'default';
}

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  permissionMode: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sequence: number;
  role: 'user' | 'assistant';
  content: string;
  status: 'PENDING' | 'STREAMING' | 'COMPLETE' | 'FAILED';
  toolCalls: { name: string; input: Record<string, unknown> }[];
  error: string | null;
  createdAt: string;
}
