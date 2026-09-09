import path from 'node:path';
import { createLogger, loadConfig, type Logger } from '@ai-engine/shared';
import {
  capabilitiesForPhase,
  type ExecutionPhase,
  type Job,
  type Project,
  type Story,
  type StoryRevision,
  type Task,
} from '@ai-engine/domain';
import { createRepositories, type Database, type Repositories } from '@ai-engine/db';
import { EventLog } from '@ai-engine/events';
import { FilesystemArtifactStore, type ArtifactStore } from '@ai-engine/artifacts';
import { createProviderOrMock } from '@ai-engine/ai-provider';
import { ALL_TOOLS, LocalCommandExecutor, SandboxCommandExecutor, ToolRegistry, toolPolicyVersion, type CommandExecutor, type ToolContext } from '@ai-engine/tools';
import { SecretsService } from '@ai-engine/security';
import { ProjectBrain } from '@ai-engine/project-brain';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import type { ProjectContext } from '@ai-engine/agents';
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
    principles,
    invariants,
    runtimeManifest: manifest?.manifest ?? null,
    knowledgeSummary,
  };
}

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

export async function createToolEnvironment(input: {
  context: JobContext;
  runId: string;
  phase: ExecutionPhase;
  allowWeb?: boolean;
}): Promise<{ registry: ToolRegistry; toolContext: ToolContext }> {
  const { context, runId, phase } = input;
  let sequence = 0;

  const registry = new ToolRegistry(ALL_TOOLS, async (record) => {
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
  });

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
