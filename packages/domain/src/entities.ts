import type { ExecutionPhase } from './capabilities';
import type { ConflictKind, ConflictSeverity, ImpactResourceKind } from './impact';
import type { JobStatus, JobType } from './job-types';
import type { ReviewDocument } from './review';
import type { RiskLevel } from './risk';
import type { TaskSize } from './task-size';
import type { TaskState } from './task-state';

/**
 * A repository the system works on, or the installation of the system itself.
 * An installation never pushes: its work is applied locally and the engine is
 * restarted onto it.
 */
export type ProjectKind = 'PROJECT' | 'INSTALLATION';

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  remoteUrl: string | null;
  /** An installation is the engine itself, registered so stories can change it. */
  kind: ProjectKind;
  description: string | null;
  /**
   * A project added from the cockpit is not usable until its runtime manifest
   * and its first knowledge snapshot exist. Holding that state here is what lets
   * the cockpit say "still preparing" instead of failing the first story.
   */
  setupState: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';
  setupError: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Story {
  id: string;
  projectId: string;
  title: string;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoryRevision {
  id: string;
  storyId: string;
  revision: number;
  body: string;
  createdBy: string;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  storyId: string;
  storyRevisionId: string;
  state: TaskState;
  previousState: TaskState | null;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  knowledgeSnapshotId: string | null;
  riskLevel: RiskLevel | null;
  /**
   * How big this change is, classified once by the review and then held. Null on
   * a task created before it was recorded, which makes the phase classify again.
   */
  size: TaskSize | null;
  qaIteration: number;
  baseMoved: boolean;
  blockedReason: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRun {
  id: string;
  /** Null for work that is not a task: an idea intake or a chat turn. */
  taskId: string | null;
  projectId: string;
  /** What this run was for. Every kind shares one usage ledger. */
  kind: 'TASK' | 'IDEA' | 'CHAT';
  /** The idea session or chat session, when this is not a task run. */
  subjectId: string | null;
  phase: ExecutionPhase;
  agentType: string;
  agentVersionId: string | null;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  finishedAt: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Null means never recorded. Zero means the run genuinely cost nothing. */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  /** Measured per-model usage as the engine reported it, shape unspecified. */
  modelUsage: Record<string, unknown> | null;
  subagentStats: Record<string, unknown> | null;
  /** The session the engine ran in, written before the process spawns. */
  sessionId: string | null;
  /**
   * Whether this run continued an earlier conversation. Null means never
   * recorded, which is what an engine without sessions leaves behind; false is a
   * deliberate cold start and true is a resume.
   */
  resumed: boolean | null;
  /** The reasoning effort actually sent, so spend can be read against it. */
  effort: string | null;
  /** The model the engine ran, or null when its own default was used. */
  model: string | null;
  errorMessage: string | null;
}

export interface TaskCheckpoint {
  id: string;
  taskId: string;
  runId: string | null;
  state: TaskState;
  gitHead: string | null;
  diffArtifactId: string | null;
  workspaceMetadata: Record<string, unknown>;
  migrationState: Record<string, unknown>;
  runningServices: string[];
  agentVersions: Record<string, string>;
  knowledgeSnapshotId: string | null;
  planPosition: number;
  createdAt: string;
}

export interface Review {
  id: string;
  taskId: string;
  kind: 'ENGINEERING' | 'SUPPLEMENTAL' | 'FINAL';
  currentVersion: number;
  status: 'DRAFT' | 'READY' | 'APPROVED' | 'SUPERSEDED';
  createdAt: string;
  updatedAt: string;
}

export interface ReviewVersion {
  id: string;
  reviewId: string;
  version: number;
  document: ReviewDocument;
  markdown: string;
  generatedByRunId: string | null;
  createdAt: string;
}

export interface ReviewNote {
  id: string;
  reviewId: string;
  reviewVersionId: string;
  sectionKey: string | null;
  anchorText: string;
  anchorStart: number | null;
  anchorEnd: number | null;
  note: string;
  status: 'OPEN' | 'ADDRESSED' | 'REJECTED';
  createdBy: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  taskId: string;
  kind: 'REVIEW' | 'HIGH_RISK_EXECUTION' | 'PR' | 'SUPPLEMENTAL';
  reviewVersionId: string | null;
  decision: 'APPROVED' | 'REJECTED';
  comment: string | null;
  decidedBy: string;
  decidedAt: string;
}

export type AgentKind = 'intake' | 'research' | 'review' | 'implementation' | 'qa' | 'learning' | 'chat';

export interface AgentDefinition {
  id: string;
  type: AgentKind;
  name: string;
  currentVersionId: string | null;
  createdAt: string;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  prompt: string;
  promptHash: string;
  provider: string;
  model: string;
  modelConfig: Record<string, unknown>;
  toolPolicyVersion: string;
  createdAt: string;
}

export interface ToolCall {
  id: string;
  taskId: string;
  runId: string;
  sequence: number;
  toolName: string;
  input: Record<string, unknown>;
  outputSummary: string;
  outputArtifactId: string | null;
  status: 'OK' | 'ERROR' | 'DENIED';
  durationMs: number;
  createdAt: string;
}

export interface SystemEvent {
  eventId: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  eventType: string;
  actorType: string;
  actorId: string;
  payload: Record<string, unknown>;
  sequence: string;
  createdAt: string;
}

export interface Job {
  id: string;
  taskId: string | null;
  /** Set for work that belongs to a project rather than to one of its tasks. */
  projectId: string | null;
  jobType: JobType;
  /** Hand-ordered position in the single global queue. */
  position: string;
  /** Whether this job occupies one of the global concurrency slots. */
  consumesSlot: boolean;
  /** Set when a person parked this one entry without pausing the whole queue. */
  heldAt: string | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  lockedBy: string | null;
  lockedAt: string | null;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ArtifactRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  kind: string;
  contentType: string;
  sizeBytes: number;
  storagePath: string;
  checksum: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Principle {
  id: string;
  projectId: string;
  category: string;
  statement: string;
  scope: string;
  status: 'ACTIVE' | 'SUPERSEDED' | 'REJECTED';
  strength: number;
  evidenceCount: number;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSnapshot {
  id: string;
  projectId: string;
  sequence: number;
  gitCommit: string;
  status: 'BUILDING' | 'READY' | 'STALE';
  createdAt: string;
}

export interface KnowledgeEntity {
  id: string;
  snapshotId: string;
  kind: string;
  name: string;
  path: string | null;
  signature: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
}

export interface KnowledgeEdge {
  id: string;
  snapshotId: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  metadata: Record<string, unknown>;
}

export interface Invariant {
  id: string;
  projectId: string;
  statement: string;
  scope: string;
  status: 'ACTIVE' | 'PROPOSED' | 'RETIRED';
  confidence: number;
  createdAt: string;
}

export interface ImpactManifest {
  id: string;
  taskId: string;
  version: number;
  createdAt: string;
}

export interface ImpactResourceRow {
  id: string;
  manifestId: string;
  kind: ImpactResourceKind;
  identifier: string;
  access: 'read' | 'write';
  source: string;
}

export interface TaskConflict {
  id: string;
  taskId: string;
  otherTaskId: string;
  kind: ConflictKind;
  severity: ConflictSeverity;
  resource: string;
  description: string;
  status: 'OPEN' | 'RESOLVED' | 'IGNORED';
  createdAt: string;
}

export interface ResourceLock {
  id: string;
  taskId: string;
  resourceKind: ImpactResourceKind;
  resourceKey: string;
  mode: 'HARD' | 'SOFT';
  acquiredAt: string;
  releasedAt: string | null;
}

export interface Sandbox {
  id: string;
  taskId: string;
  workspacePath: string;
  containerId: string | null;
  containerName: string | null;
  image: string;
  status: 'CREATING' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'DESTROYED' | 'ERROR';
  mode: 'READ_ONLY' | 'READ_WRITE';
  createdAt: string;
  updatedAt: string;
}

export interface TestRun {
  id: string;
  taskId: string;
  runId: string | null;
  command: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  logArtifactId: string | null;
  createdAt: string;
}

export interface QaRun {
  id: string;
  taskId: string;
  runId: string;
  iteration: number;
  verdict: 'APPROVED' | 'REJECTED' | 'BLOCKED';
  findings: QaFinding[];
  /**
   * Remarks the run did not block on. They were described in the summary prose
   * and then never reached the agent that could have acted on them.
   */
  notes: QaNote[];
  createdAt: string;
}

export interface QaNote {
  summary: string;
  detail: string;
  file: string | null;
}

export interface QaFinding {
  id: string;
  category:
    | 'correctness'
    | 'regression'
    | 'edge_case'
    | 'security'
    | 'invariant'
    | 'architecture'
    | 'migration'
    | 'tests'
    | 'performance';
  severity: 'low' | 'medium' | 'high' | 'blocking';
  file: string | null;
  summary: string;
  detail: string;
  suggestedFix: string;
  status?: 'OPEN' | 'RESOLVED';
}

export interface RuntimeManifest {
  id: string;
  projectId: string;
  version: number;
  manifest: RuntimeManifestDocument;
  validated: boolean;
  validationLog: string | null;
  createdAt: string;
}

export interface RuntimeManifestDocument {
  project: { language: string[]; packageManager?: string | null };
  setup: { commands: string[] };
  build: { commands: string[] };
  test: { commands: string[] };
  lint: { commands: string[] };
  services: { name: string; start: string }[];
  database: { migrate: string[]; reset: string[] };
}

export interface Metric {
  id: string;
  projectId: string;
  taskId: string | null;
  name: string;
  value: number;
  labels: Record<string, string>;
  createdAt: string;
}

export interface InstallationApply {
  id: string;
  projectId: string;
  taskId: string | null;
  source: 'TASK' | 'UPSTREAM';
  candidateRef: string;
  previousCommit: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';
  step: string;
  log: string;
  startedAt: string;
  finishedAt: string | null;
}

/** A value the cockpit may change while the system runs. */
export interface Setting {
  key: string;
  value: string;
  secret: boolean;
  updatedAt: string;
}

/**
 * One row of the single global queue, with everything needed to show it: which
 * project and story it belongs to, and what it is waiting on.
 */
export interface QueueEntry {
  id: string;
  jobType: JobType;
  status: JobStatus;
  position: string;
  consumesSlot: boolean;
  heldAt: string | null;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  lockedBy: string | null;
  lockedAt: string | null;
  lastError: string | null;
  taskId: string | null;
  taskState: TaskState | null;
  projectId: string | null;
  projectName: string | null;
  storyTitle: string | null;
}

/** A task that cannot move until a person answers something. */
export interface WaitingTask {
  taskId: string;
  projectId: string;
  projectName: string;
  storyTitle: string;
  state: TaskState;
  since: string;
  /** Blocking decisions still open on the current review version. */
  openDecisions: number;
  blockedReason: string | null;
}

export type IdeaSessionStatus = 'QUEUED' | 'THINKING' | 'ASKING' | 'READY' | 'FAILED' | 'DISCARDED';

export interface IdeaSession {
  id: string;
  projectId: string;
  idea: string;
  status: IdeaSessionStatus;
  /** What the agent understood, so a wrong reading shows before the questions. */
  understanding: string | null;
  round: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IdeaQuestionOption {
  key: string;
  label: string;
  detail: string;
}

export interface IdeaQuestion {
  id: string;
  sessionId: string;
  round: number;
  sequence: number;
  question: string;
  rationale: string;
  options: IdeaQuestionOption[];
  /** An option key, or 'custom' when the answer was written by hand. */
  chosenKey: string | null;
  customAnswer: string | null;
  answeredAt: string | null;
  createdAt: string;
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
  updatedAt: string;
}

export interface ReviewDecisionRecord {
  id: string;
  taskId: string;
  reviewVersionId: string;
  key: string;
  question: string;
  detail: string;
  blocking: boolean;
  options: { key: string; label: string; detail: string; consequence: string; recommended: boolean }[];
  status: 'OPEN' | 'ANSWERED';
  /** An option key, or 'custom', or 'agent' to leave the choice to the engineer. */
  chosenKey: string | null;
  customAnswer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  engineSessionId: string | null;
  permissionMode: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  sequence: number;
  role: 'user' | 'assistant';
  content: string;
  status: 'PENDING' | 'STREAMING' | 'COMPLETE' | 'FAILED';
  toolCalls: { name: string; input: Record<string, unknown> }[];
  runId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
