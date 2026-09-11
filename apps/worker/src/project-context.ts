import { loadConfig, type Logger } from '@ai-engine/shared';
import type { ExecutionPhase, Job, Project, TaskSize } from '@ai-engine/domain';
import { createRepositories, type Database, type Repositories, type ScopedSettings } from '@ai-engine/db';
import { EventLog } from '@ai-engine/events';
import { DatabaseArtifactStore, type ArtifactStore } from '@ai-engine/artifacts';
import { ClaudeCodeAgentRunner } from '@ai-engine/claude-code';
import { ProjectBrain } from '@ai-engine/project-brain';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import { BuiltinAgentRunner, type AgentRunner, type ProjectContext } from '@ai-engine/agents';
import { ALL_TOOLS, LocalCommandExecutor, ToolRegistry, type ToolContext } from '@ai-engine/tools';
import { SETTING_KEYS, capabilitiesForPhase } from '@ai-engine/domain';
import { createAiProvider } from './job-context';

/**
 * What a job that belongs to a project rather than to one of its tasks gets.
 *
 * Preparing a newly added project, refreshing its knowledge, turning an idea
 * into stories and answering a chat turn all happen against the repository
 * itself: there is no branch, no worktree and no task state machine involved.
 * Handing those a task context would mean inventing a task, which is how a
 * half-real row ends up in the cockpit.
 */
export interface ProjectJobContext {
  db: Database;
  repos: Repositories;
  events: EventLog;
  artifacts: ArtifactStore;
  brain: ProjectBrain;
  knowledge: KnowledgeService;
  logger: Logger;
  /** Settings as this project sees them: its own value first, the installation's after. */
  settings: ScopedSettings;
  workerId: string;
  installRoot: string;
  job: Job;
  project: Project;
}

export async function buildProjectJobContext(input: {
  db: Database;
  job: Job;
  workerId: string;
  logger: Logger;
}): Promise<ProjectJobContext> {
  const repos = createRepositories(input.db);
  const projectId = String(input.job.payload['projectId'] ?? input.job.projectId ?? '');
  if (!projectId) throw new Error(`Job ${input.job.id} has no project`);
  const project = await repos.projects.getById(projectId);

  return {
    db: input.db,
    repos,
    events: new EventLog(input.db),
    artifacts: new DatabaseArtifactStore(input.db),
    brain: new ProjectBrain(input.db),
    knowledge: new KnowledgeService(input.db),
    logger: input.logger.child({ projectId, jobType: input.job.jobType }),
    settings: repos.settings.forProject(projectId),
    workerId: input.workerId,
    installRoot: loadConfig().paths.installRoot,
    job: input.job,
    project,
  };
}

/** The Project Brain and runtime knowledge, for an agent with no task. */
export async function buildProjectAgentContext(context: ProjectJobContext): Promise<ProjectContext> {
  const [principles, invariants, manifest, snapshot] = await Promise.all([
    context.brain.activePrinciples(context.project.id),
    context.brain.activeInvariants(context.project.id),
    context.repos.runtimeManifests.latest(context.project.id),
    context.knowledge.latest(context.project.id),
  ]);

  return {
    kind: context.project.kind,
    principles,
    invariants,
    runtimeManifest: manifest?.manifest ?? null,
    knowledgeSummary: snapshot ? await context.knowledge.summarize(snapshot.id).catch(() => null) : null,
  };
}

const EFFORT_BY_SIZE: Record<TaskSize, 'low' | 'medium' | 'high'> = {
  SMALL: 'low',
  STANDARD: 'medium',
  LARGE: 'high',
};

/**
 * An agent runner pointed at the project repository itself.
 *
 * A task's runner works on a branch of the same checkout. These phases have no
 * task and no branch of their own, so they run on whatever the project is
 * currently on, and that is why their read-only permission mode matters more
 * here than anywhere else: this is the owner's own working directory.
 */
export async function createProjectAgentRunner(input: {
  context: ProjectJobContext;
  phase: ExecutionPhase;
  size?: TaskSize;
  permissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';
  onToolUse?: (use: { name: string; input: Record<string, unknown> }) => void | Promise<void>;
}): Promise<AgentRunner> {
  const config = loadConfig();
  const { context, phase } = input;

  if (config.agents.engine === 'claude-code') {
    const model = (await context.settings.raw(SETTING_KEYS.claudeModel)) ?? config.agents.claudeModel;
    return new ClaudeCodeAgentRunner({
      workspacePath: context.project.repoPath,
      timeoutMs: config.agents.claudeTimeoutMs,
      resultTimeoutMs: config.agents.claudeResultTimeoutMs,
      binary: config.agents.claudeBinary,
      allowSubagents: config.agents.allowSubagents,
      ...(input.size ? { effort: EFFORT_BY_SIZE[input.size] } : {}),
      ...(input.permissionMode ? { chatPermissionMode: input.permissionMode } : {}),
      ...(model ? { model } : {}),
      logger: context.logger,
      ...(input.onToolUse ? { onToolUse: input.onToolUse } : {}),
    });
  }

  const registry = new ToolRegistry(ALL_TOOLS);
  const toolContext: ToolContext = {
    projectId: context.project.id,
    taskId: context.project.id,
    runId: context.job.id,
    workspacePath: context.project.repoPath,
    phase,
    capabilities: capabilitiesForPhase(phase),
    executor: new LocalCommandExecutor(context.project.repoPath),
    artifacts: context.artifacts,
    logger: context.logger,
    secretValues: [],
    baseCommit: '',
    allowWeb: true,
  };
  return new BuiltinAgentRunner({
    provider: createAiProvider(),
    registry,
    toolContext,
    logger: context.logger,
  });
}
