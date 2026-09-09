import { AppError, createLogger, loadConfig, type Logger } from '@ai-engine/shared';
import type { Sandbox } from '@ai-engine/domain';
import { createRepositories, type Database } from '@ai-engine/db';
import { WorktreeManager } from '@ai-engine/git';
import { SecretsService } from '@ai-engine/security';
import { DockerClient, runLocal, type ExecOutcome } from './docker';

export interface EnsureSandboxInput {
  taskId: string;
  branch: string;
  baseCommit: string;
  mode: 'READ_ONLY' | 'READ_WRITE';
}

/**
 * The only service with Docker privileges. It owns the task worktrees and the
 * containers that run agent commands, and it never runs agent logic itself.
 */
export class SandboxManager {
  private readonly docker = new DockerClient();
  private readonly secrets = new SecretsService();
  private readonly logger: Logger;

  constructor(private readonly db: Database, logger?: Logger) {
    this.logger = logger ?? createLogger('sandbox-manager');
  }

  private containerName(taskId: string): string {
    return `ai-engine-task-${taskId.slice(0, 12)}`;
  }

  private async repositoryPath(taskId: string): Promise<string> {
    const repos = createRepositories(this.db);
    const task = await repos.tasks.getById(taskId);
    const project = await repos.projects.getById(task.projectId);
    return project.repoPath;
  }

  async ensure(input: EnsureSandboxInput): Promise<Sandbox> {
    const config = loadConfig();
    const repos = createRepositories(this.db);
    const repositoryPath = await this.repositoryPath(input.taskId);
    const worktrees = new WorktreeManager(repositoryPath, config.paths.workspacesRoot);

    const existing = await repos.sandboxes.findActiveByTask(input.taskId);
    const workspaceExists = await worktrees.exists(input.taskId);

    if (!workspaceExists) {
      await worktrees.create({ taskId: input.taskId, branch: input.branch, baseCommit: input.baseCommit });
    }
    const workspacePath = worktrees.workspacePathFor(input.taskId);

    let sandbox =
      existing ??
      (await repos.sandboxes.create({
        taskId: input.taskId,
        workspacePath,
        image: config.sandbox.image,
        mode: input.mode,
        containerName: this.containerName(input.taskId),
      }));

    if (!config.sandbox.enabled) {
      return repos.sandboxes.update(sandbox.id, { status: 'RUNNING', mode: input.mode });
    }

    const name = sandbox.containerName ?? this.containerName(input.taskId);
    const state = await this.docker.containerState(name);

    // The workspace mount is read-only until the review has been approved, so
    // the container has to be recreated when the mode changes.
    const needsRecreate = state === null || sandbox.mode !== input.mode;
    if (needsRecreate) {
      if (state !== null) await this.docker.remove(name);
      if (!(await this.docker.imageExists(config.sandbox.image))) {
        throw new AppError(
          'sandbox_image_missing',
          `The sandbox image ${config.sandbox.image} is not available. Build it with "docker compose build sandbox".`,
          500,
        );
      }
      const containerId = await this.docker.create({
        name,
        image: config.sandbox.image,
        workspacePath,
        readOnlyWorkspace: input.mode === 'READ_ONLY',
        cpuLimit: config.sandbox.cpuLimit,
        memoryLimit: config.sandbox.memoryLimit,
        networkMode: config.sandbox.networkMode,
        environment: {
          ...this.secrets.sandboxEnvironment(['package_registry', 'development_api']),
          AI_ENGINE_TASK_ID: input.taskId,
        },
      });
      sandbox = await repos.sandboxes.update(sandbox.id, {
        containerId,
        containerName: name,
        status: 'RUNNING',
        mode: input.mode,
      });
    } else if (state === 'paused') {
      await this.docker.unpause(name);
      sandbox = await repos.sandboxes.update(sandbox.id, { status: 'RUNNING' });
    } else if (state === 'exited') {
      await this.docker.remove(name);
      return this.ensure(input);
    }

    return sandbox;
  }

  async setMode(taskId: string, mode: 'READ_ONLY' | 'READ_WRITE'): Promise<Sandbox> {
    const repos = createRepositories(this.db);
    const sandbox = await repos.sandboxes.findActiveByTask(taskId);
    if (!sandbox) throw new AppError('no_sandbox', `Task ${taskId} has no sandbox`, 404);
    if (sandbox.mode === mode) return sandbox;
    const task = await repos.tasks.getById(taskId);
    return this.ensure({ taskId, branch: task.branchName, baseCommit: task.baseCommit, mode });
  }

  async exec(input: {
    taskId: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    env?: Record<string, string>;
    readOnly?: boolean;
  }): Promise<ExecOutcome> {
    const config = loadConfig();
    const repos = createRepositories(this.db);
    const sandbox = await repos.sandboxes.findActiveByTask(input.taskId);
    if (!sandbox) throw new AppError('no_sandbox', `Task ${input.taskId} has no sandbox`, 404);

    if (input.readOnly === false && sandbox.mode === 'READ_ONLY') {
      throw new AppError('read_only_sandbox', 'This sandbox is read-only until the review is approved', 403);
    }

    const timeoutMs = Math.min(input.timeoutMs, config.sandbox.commandTimeoutMs);

    if (!config.sandbox.enabled) {
      return runLocal({
        command: input.command,
        cwd: input.cwd ?? sandbox.workspacePath,
        timeoutMs,
        ...(input.env ? { env: input.env } : {}),
      });
    }

    const name = sandbox.containerName ?? this.containerName(input.taskId);
    return this.docker.exec(name, input.command, timeoutMs, input.env ?? {});
  }

  async pause(taskId: string): Promise<void> {
    const repos = createRepositories(this.db);
    const sandbox = await repos.sandboxes.findActiveByTask(taskId);
    if (!sandbox) return;
    if (sandbox.containerName) await this.docker.pause(sandbox.containerName);
    await repos.sandboxes.update(sandbox.id, { status: 'PAUSED' });
  }

  async resume(taskId: string): Promise<void> {
    const repos = createRepositories(this.db);
    const sandbox = await repos.sandboxes.findActiveByTask(taskId);
    if (!sandbox) return;
    if (sandbox.containerName) await this.docker.unpause(sandbox.containerName);
    await repos.sandboxes.update(sandbox.id, { status: 'RUNNING' });
  }

  async destroy(taskId: string, options: { keepWorkspace?: boolean } = {}): Promise<void> {
    const config = loadConfig();
    const repos = createRepositories(this.db);
    const sandbox = await repos.sandboxes.findActiveByTask(taskId);
    if (sandbox?.containerName) await this.docker.remove(sandbox.containerName);
    if (sandbox) await repos.sandboxes.update(sandbox.id, { status: 'DESTROYED' });

    if (!options.keepWorkspace) {
      const repositoryPath = await this.repositoryPath(taskId).catch(() => null);
      if (repositoryPath) {
        const worktrees = new WorktreeManager(repositoryPath, config.paths.workspacesRoot);
        await worktrees.remove(taskId, { force: true });
      }
    }
    this.logger.info('sandbox destroyed', { taskId });
  }

  async health(): Promise<{ docker: boolean; sandboxes: number; image: string; imageAvailable: boolean }> {
    const config = loadConfig();
    const repos = createRepositories(this.db);
    const active = await repos.sandboxes.listActive();
    const docker = config.sandbox.enabled ? await this.docker.available() : true;
    return {
      docker,
      sandboxes: active.length,
      image: config.sandbox.image,
      imageAvailable: config.sandbox.enabled ? await this.docker.imageExists(config.sandbox.image) : true,
    };
  }

  /** Reconciles the database against what Docker actually has after a restart. */
  async reconcile(): Promise<{ checked: number; repaired: number }> {
    const repos = createRepositories(this.db);
    const active = await repos.sandboxes.listActive();
    let repaired = 0;
    for (const sandbox of active) {
      if (!sandbox.containerName) continue;
      const state = await this.docker.containerState(sandbox.containerName);
      if (state === null && sandbox.status !== 'DESTROYED') {
        await repos.sandboxes.update(sandbox.id, { status: 'STOPPED' });
        repaired++;
      }
    }
    return { checked: active.length, repaired };
  }
}
