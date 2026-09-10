import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, createLogger, loadConfig, type Logger } from '@ai-engine/shared';
import {
  capabilitiesForPhase,
  type ExecutionPhase,
  type Job,
  type Project,
  type Story,
  type StoryRevision,
  type Task,
  type TaskSize,
} from '@ai-engine/domain';
import { createRepositories, type Database, type Repositories } from '@ai-engine/db';
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
 * Records what the engine actually cost and whether it tried anything it was
 * not allowed to do. A non-empty denial list is a signal worth a human's eyes.
 */
export async function recordEngineMetrics(
  context: JobContext,
  agentType: string,
  outcome: { costUsd: number | null; toolCallCount: number; permissionDenials: unknown[]; sessionId: string | null },
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
