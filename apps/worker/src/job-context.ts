import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, createLogger, loadConfig, type Logger } from '@ai-engine/shared';
import {
  capabilitiesForPhase,
  shouldResumeFailedRun,
  type ExecutionPhase,
  type Job,
  type Project,
  type Story,
  type StoryRevision,
  type Task,
  type TaskSize,
} from '@ai-engine/domain';
import { createRepositories, type Database, type Repositories, type RunCompletion } from '@ai-engine/db';
import { EventLog } from '@ai-engine/events';
import { FilesystemArtifactStore, type ArtifactStore } from '@ai-engine/artifacts';
import { createProviderOrMock } from '@ai-engine/ai-provider';
import { ALL_TOOLS, LocalCommandExecutor, SandboxCommandExecutor, ToolRegistry, toolPolicyVersion, type CommandExecutor, type ToolContext } from '@ai-engine/tools';
import { ClaudeCodeAgentRunner } from '@ai-engine/claude-code';
import { GitClient } from '@ai-engine/git';
import { SecretsService } from '@ai-engine/security';
import { ProjectBrain } from '@ai-engine/project-brain';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import { BuiltinAgentRunner, type AgentRunner, type ProjectContext } from '@ai-engine/agents';
import { Orchestrator } from '@ai-engine/orchestrator';

export interface JobContext {
  db: Database;
  repos: Repositories;
  events: EventLog;
  orchestrator: Orchestrator;
  artifacts: ArtifactStore;
  brain: ProjectBrain;
  knowledge: KnowledgeService;
  secrets: SecretsService;
  logger: Logger;
  workerId: string;
  /** Where the engine itself lives: its prompts, policies and state. */
  installRoot: string;
  job: Job;
  task: Task;
  project: Project;
  story: Story;
  revision: StoryRevision;
}

export async function buildJobContext(input: {
  db: Database;
  job: Job;
  workerId: string;
  logger: Logger;
}): Promise<JobContext> {
  const repos = createRepositories(input.db);
  const task = await repos.tasks.getById(String(input.job.payload['taskId'] ?? input.job.taskId));
  const project = await repos.projects.getById(task.projectId);
  const story = await repos.stories.getById(task.storyId);
  const revision = await repos.stories.getRevision(task.storyRevisionId);

  return {
    db: input.db,
    repos,
    events: new EventLog(input.db),
    orchestrator: new Orchestrator(input.db),
    artifacts: new FilesystemArtifactStore(input.db),
    brain: new ProjectBrain(input.db),
    knowledge: new KnowledgeService(input.db),
    secrets: new SecretsService(),
    logger: input.logger.child({ taskId: task.id, jobType: input.job.jobType }),
    workerId: input.workerId,
    installRoot: loadConfig().paths.installRoot,
    job: input.job,
    task,
    project,
    story,
    revision,
  };
}

/** The Project Brain plus runtime knowledge, shared by every agent prompt. */
export async function buildProjectContext(context: JobContext): Promise<ProjectContext> {
  const [principles, invariants, manifest] = await Promise.all([
    context.brain.activePrinciples(context.project.id),
    context.brain.activeInvariants(context.project.id),
    context.repos.runtimeManifests.latest(context.project.id),
  ]);

  let knowledgeSummary: string | null = null;
  if (context.task.knowledgeSnapshotId) {
    knowledgeSummary = await context.knowledge.summarize(context.task.knowledgeSnapshotId).catch(() => null);
  }

  return {
    kind: context.project.kind,
    principles,
    invariants,
    runtimeManifest: manifest?.manifest ?? null,
    knowledgeSummary,
  };
}

const EFFORT_BY_SIZE: Record<TaskSize, 'low' | 'medium' | 'high'> = {
  SMALL: 'low',
  STANDARD: 'medium',
  LARGE: 'high',
};

export function workspacePathFor(taskId: string): string {
  return path.join(loadConfig().paths.workspacesRoot, `task-${taskId}`);
}

/**
 * Where this task's artifacts live, matching the layout the artifact store
 * writes. It sits outside the worktree, so an agent only reaches it when the
 * phase is given it explicitly.
 */
export function taskArtifactsPathFor(projectId: string, taskId: string): string {
  return path.join(loadConfig().paths.artifactsRoot, projectId, taskId);
}

/**
 * Workers never talk to Docker. When sandboxing is enabled every command goes
 * through the sandbox manager; otherwise it runs locally in the worktree.
 */
export function createExecutor(taskId: string): CommandExecutor {
  const config = loadConfig();
  return config.sandbox.enabled
    ? new SandboxCommandExecutor(config.service.sandboxManagerUrl, taskId)
    : new LocalCommandExecutor(workspacePathFor(taskId));
}

/**
 * Records every agent action, whichever engine produced it, so the audit trail
 * does not depend on which executor ran.
 */
export function createToolAuditSink(context: JobContext, runId: string, phase: ExecutionPhase) {
  let sequence = 0;
  return async (record: {
    toolName: string;
    input: Record<string, unknown>;
    summary: string;
    artifactId?: string | null;
    status: 'OK' | 'ERROR' | 'DENIED';
    durationMs: number;
  }): Promise<void> => {
    sequence++;
    await context.repos.toolCalls.record({
      taskId: context.task.id,
      runId,
      sequence,
      toolName: record.toolName,
      input: record.input,
      outputSummary: record.summary,
      outputArtifactId: record.artifactId ?? null,
      status: record.status,
      durationMs: record.durationMs,
    });
    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      runId,
      eventType: 'ToolCalled',
      actorType: 'agent',
      actorId: phase,
      payload: { tool: record.toolName, status: record.status, durationMs: record.durationMs },
    });
  };
}

export async function createToolEnvironment(input: {
  context: JobContext;
  runId: string;
  phase: ExecutionPhase;
  allowWeb?: boolean;
}): Promise<{ registry: ToolRegistry; toolContext: ToolContext }> {
  const { context, runId, phase } = input;
  const registry = new ToolRegistry(ALL_TOOLS, createToolAuditSink(context, runId, phase));

  const toolContext: ToolContext = {
    projectId: context.project.id,
    taskId: context.task.id,
    runId,
    workspacePath: workspacePathFor(context.task.id),
    phase,
    capabilities: capabilitiesForPhase(phase),
    executor: createExecutor(context.task.id),
    artifacts: context.artifacts,
    logger: context.logger,
    secretValues: context.secrets.knownValues(),
    baseCommit: context.task.baseCommit,
    allowWeb: input.allowWeb ?? (phase === 'RESEARCH' || phase === 'REVIEW'),
  };

  return { registry, toolContext };
}

/** Registers the agent prompt as a version so runs stay reproducible. */
export async function resolveAgentVersion(
  context: JobContext,
  type: 'research' | 'review' | 'implementation' | 'qa' | 'learning',
  prompt: string,
): Promise<string> {
  const config = loadConfig();
  const agent = await context.repos.agents.ensureAgent(type, `${type} agent`);
  const version = await context.repos.agents.registerVersion({
    agentId: agent.id,
    prompt,
    provider: config.ai.provider,
    model: config.ai.model,
    modelConfig: { temperature: config.ai.temperature, maxOutputTokens: config.ai.maxOutputTokens },
    toolPolicyVersion: toolPolicyVersion(),
  });
  return version.id;
}

export function createAiProvider() {
  return createProviderOrMock();
}

/**
 * Chooses the execution engine. Claude Code runs the agent as a headless
 * session inside the task worktree; the built-in loop is the offline fallback
 * and what the tests exercise.
 */
export async function createAgentRunner(input: {
  context: JobContext;
  runId: string;
  phase: ExecutionPhase;
  allowWeb?: boolean;
  /** Scales reasoning effort to the change. Omitted means the phase default. */
  size?: TaskSize;
  /** Directories outside the worktree this phase's work pass may read. */
  additionalDirectories?: string[];
}): Promise<AgentRunner> {
  const config = loadConfig();
  const { context, runId, phase } = input;

  if (config.agents.engine === 'claude-code') {
    const audit = createToolAuditSink(context, runId, phase);
    return new ClaudeCodeAgentRunner({
      workspacePath: workspacePathFor(context.task.id),
      timeoutMs: config.agents.claudeTimeoutMs,
      resultTimeoutMs: config.agents.claudeResultTimeoutMs,
      binary: config.agents.claudeBinary,
      allowSubagents: config.agents.allowSubagents,
      ...(input.additionalDirectories?.length ? { additionalDirectories: input.additionalDirectories } : {}),
      ...(input.size ? { effort: EFFORT_BY_SIZE[input.size] } : {}),
      ...(config.agents.claudeModel ? { model: config.agents.claudeModel } : {}),
      logger: context.logger,
      onToolUse: async (use) => {
        await audit({
          toolName: use.name,
          input: use.input,
          summary: `${use.name} via claude-code`,
          status: 'OK',
          durationMs: 0,
        });
      },
    });
  }

  const { registry, toolContext } = await createToolEnvironment(input);
  return new BuiltinAgentRunner({
    provider: createAiProvider(),
    registry,
    toolContext,
    logger: context.logger,
  });
}

/**
 * What a finished run spent, in the shape the repository stores.
 *
 * Every call site builds its completion record through this, so a run recorded
 * from one handler carries the same numbers as a run recorded from another. The
 * cost is the engine's own figure, not derived from tokens and a price table.
 */
export function runCompletion(outcome: {
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  costUsd: number | null;
  modelUsage: Record<string, unknown> | null;
  subagentStats: Record<string, unknown> | null;
  sessionId?: string | null;
  resumed?: boolean | null;
  effort?: string | null;
  model?: string | null;
}): RunCompletion {
  return {
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
    cacheReadTokens: outcome.usage.cacheReadTokens,
    cacheCreationTokens: outcome.usage.cacheCreationTokens,
    costUsd: outcome.costUsd,
    modelUsage: outcome.modelUsage,
    subagentStats: outcome.subagentStats,
    // The id the engine actually reported, which replaces the one written when
    // the session opened. They are the same unless the CLI renamed the session.
    // An engine that reports no id at all leaves the recorded one standing
    // rather than overwriting it with nothing.
    sessionId: outcome.sessionId || null,
    resumed: outcome.resumed ?? null,
    effort: outcome.effort ?? null,
    model: outcome.model ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a failed run spent, read off the error the engine rejected with.
 *
 * The CLI builds a full result, usage and all, and only then discovers the run
 * reported an error; that result is attached to the rejection rather than
 * discarded. A timeout has nothing to attach and returns null, so the run keeps
 * whatever was recorded when it started.
 */
function runFailureSpend(error: unknown): RunCompletion | undefined {
  const details = error instanceof AppError ? error.details : undefined;
  if (!details) return undefined;

  const rawUsage = details['usage'];
  const usage =
    rawUsage && typeof rawUsage === 'object'
      ? (rawUsage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number })
      : null;

  // An empty id is what the CLI reports when it never named a session, and it is
  // not a value the run record can hold.
  const rawSessionId = details['sessionId'];
  const sessionId = typeof rawSessionId === 'string' && rawSessionId.length > 0 ? rawSessionId : null;
  if (!usage && !sessionId) return undefined;

  const costUsd = details['costUsd'];
  const modelUsage = details['modelUsage'];
  const subagentStats = details['subagentStats'];

  const spend: RunCompletion = {
    costUsd: typeof costUsd === 'number' ? costUsd : null,
    modelUsage: isRecord(modelUsage) ? modelUsage : null,
    subagentStats: isRecord(subagentStats) ? subagentStats : null,
    sessionId,
  };
  if (usage) {
    spend.inputTokens = usage.inputTokens ?? 0;
    spend.outputTokens = usage.outputTokens ?? 0;
    spend.cacheReadTokens = usage.cacheReadTokens ?? 0;
    spend.cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  }
  return spend;
}

/**
 * Records a failed run along with what it spent before it failed.
 *
 * Every handler's catch goes through here so the numbers a failed run
 * contributes are the same whichever phase produced it.
 */
export async function failRun(context: JobContext, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const spend = runFailureSpend(error);
  await context.repos.runs.fail(runId, message, spend);
}

/**
 * Writes the session a run is about to use onto its row, before the engine
 * spawns anything. Handlers hand this to the agent as onSessionStart.
 */
export function recordSessionStart(
  context: JobContext,
  runId: string,
  resumed: boolean,
): (sessionId: string) => Promise<void> {
  return async (sessionId: string) => {
    await context.repos.runs.recordSession(runId, { sessionId, resumed });
  };
}

/**
 * The session of a recent failed run for this phase, when continuing it is
 * worth trying.
 *
 * Called before the new run is started, so it reads the previous attempt rather
 * than the one about to begin. The attempt itself is what establishes whether
 * the session can still be read back: a recorded id is only a bookkeeping
 * record, and asking the CLI to resume a dead one costs a single fast
 * rejection, against a whole repository re-read for starting cold when it was
 * still warm.
 */
export async function resumableSessionFor(context: JobContext, phase: ExecutionPhase): Promise<string | null> {
  const previous = await context.repos.runs.latestForPhase(context.task.id, phase);
  if (!shouldResumeFailedRun(previous, new Date())) return null;

  context.logger.info('continuing the session of an attempt that failed recently', {
    phase,
    runId: previous!.id,
    sessionId: previous!.sessionId,
  });
  return previous!.sessionId;
}

/** True when the engine reported a subagent actually doing something. */
function reportsSubagentWork(stats: Record<string, unknown> | null): boolean {
  if (!stats) return false;
  const values = Object.values(stats);
  return values.some((value) => {
    if (typeof value === 'number') return value !== 0;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return reportsSubagentWork(value as Record<string, unknown>);
    }
    return false;
  });
}

/**
 * Records what the engine actually cost and whether it tried anything it was
 * not allowed to do. A non-empty denial list is a signal worth a human's eyes.
 */
export async function recordEngineMetrics(
  context: JobContext,
  agentType: string,
  outcome: {
    costUsd: number | null;
    toolCallCount: number;
    permissionDenials: unknown[];
    sessionId: string | null;
    subagentStats?: Record<string, unknown> | null;
  },
): Promise<void> {
  if (outcome.costUsd !== null) {
    await context.repos.metrics.record({
      projectId: context.project.id,
      taskId: context.task.id,
      name: 'agent_cost_usd',
      value: outcome.costUsd,
      labels: { agent: agentType },
    });
  }
  await context.repos.metrics.record({
    projectId: context.project.id,
    taskId: context.task.id,
    name: 'agent_tool_calls',
    value: outcome.toolCallCount,
    labels: { agent: agentType },
  });

  // Delegation is denied unless the installation turned it on, so subagent work
  // means either the denial did not hold or someone turned it on. Storing the
  // stats is not enough on its own: nobody reads a column, and this is the one
  // thing that would tell us.
  if (reportsSubagentWork(outcome.subagentStats ?? null)) {
    context.logger.warn('the engine reported a subagent doing work, which is a second context window', {
      agent: agentType,
      subagentStats: outcome.subagentStats,
    });
    await context.repos.metrics.record({
      projectId: context.project.id,
      taskId: context.task.id,
      name: 'agent_subagents',
      value: 1,
      labels: { agent: agentType },
    });
  }

  if (outcome.permissionDenials.length > 0) {
    await context.repos.metrics.record({
      projectId: context.project.id,
      taskId: context.task.id,
      name: 'agent_permission_denials',
      value: outcome.permissionDenials.length,
      labels: { agent: agentType },
    });
    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      eventType: 'ToolCalled',
      actorType: 'agent',
      actorId: agentType,
      payload: { denied: outcome.permissionDenials.length, details: outcome.permissionDenials.slice(0, 10) },
    });
  }
}

/**
 * Commits whatever the agent left in the worktree.
 *
 * Nothing else commits before integration, so an uncommitted phase result only
 * survives while its worktree does. Committing at the end of each run makes the
 * branch the record instead, which is what lets a retry or a fix continue from
 * the work rather than from the base commit.
 */
export async function commitWorkspace(context: JobContext, git: GitClient): Promise<string | null> {
  await git.addAll();
  if (!(await git.hasStagedChanges())) return null;
  return git.commit(`ai: ${context.story.title}`.slice(0, 100), {
    name: 'AI Engineering System',
    email: 'ai-engine@localhost',
  });
}

/** Kept outside the worktree so it can never be committed with the change. */
function setupMarkerFor(taskId: string): string {
  return path.join(loadConfig().paths.workspacesRoot, `.setup-${taskId}`);
}

/**
 * Installs the project's dependencies in the task worktree.
 *
 * A worktree is a bare checkout: it inherits nothing that was installed beside
 * the working copy, so a build or a test run in it fails on a missing toolchain
 * rather than on the change. The runtime manifest already declares how this
 * project installs, and this is the only place that runs it. A marker file
 * keeps it to once per worktree instead of once per phase.
 */
export async function ensureDependencies(context: JobContext): Promise<void> {
  const workspacePath = workspacePathFor(context.task.id);
  const marker = setupMarkerFor(context.task.id);
  try {
    await access(marker);
    return;
  } catch {
    // Not installed yet.
  }

  const manifest = await context.repos.runtimeManifests.latest(context.project.id);
  const commands = manifest?.manifest.setup.commands ?? [];
  if (commands.length === 0) {
    context.logger.warn('the runtime manifest declares no setup command, so the worktree keeps whatever it has');
    return;
  }

  const executor = createExecutor(context.task.id);
  for (const command of commands) {
    context.logger.info('installing dependencies in the worktree', { command });
    const outcome = await executor.run({
      command,
      cwd: workspacePath,
      timeoutMs: loadConfig().sandbox.commandTimeoutMs,
    });
    if (outcome.exitCode !== 0) {
      throw new AppError('setup_failed', `Setup command failed in the task workspace: ${command}`, 500, {
        command,
        exitCode: outcome.exitCode,
        output: outcome.stdout.slice(-4000) + outcome.stderr.slice(-4000),
      });
    }
  }
  await writeFile(marker, `${new Date().toISOString()}\n`, 'utf8');
}
