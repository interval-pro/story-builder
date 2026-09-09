import { createLogger, loadConfig } from '@ai-engine/shared';
import { WorktreeManager } from '@ai-engine/git';

const logger = createLogger('sandbox-client');

export interface SandboxDescriptor {
  id: string;
  workspacePath: string;
  mode: 'READ_ONLY' | 'READ_WRITE';
  status: string;
}

/**
 * Thin client for the sandbox manager. When Docker sandboxing is disabled the
 * worker falls back to creating the Git worktree itself, which keeps the whole
 * lifecycle usable on a machine without Docker.
 */
export class SandboxClient {
  private readonly baseUrl: string;
  private readonly enabled: boolean;

  constructor(private readonly repositoryPath: string) {
    const config = loadConfig();
    this.baseUrl = config.service.sandboxManagerUrl;
    this.enabled = config.sandbox.enabled;
  }

  async ensure(input: {
    taskId: string;
    branch: string;
    baseCommit: string;
    mode: 'READ_ONLY' | 'READ_WRITE';
  }): Promise<SandboxDescriptor> {
    if (!this.enabled) {
      const config = loadConfig();
      const manager = new WorktreeManager(this.repositoryPath, config.paths.workspacesRoot);
      const worktree = await manager.create({ taskId: input.taskId, branch: input.branch, baseCommit: input.baseCommit });
      return { id: `local-${input.taskId}`, workspacePath: worktree.path, mode: input.mode, status: 'RUNNING' };
    }

    const response = await fetch(`${this.baseUrl}/sandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`Sandbox manager refused to create a sandbox: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as SandboxDescriptor;
  }

  async setMode(taskId: string, mode: 'READ_ONLY' | 'READ_WRITE'): Promise<void> {
    if (!this.enabled) return;
    await fetch(`${this.baseUrl}/sandboxes/${taskId}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  }

  async destroy(taskId: string): Promise<void> {
    if (!this.enabled) {
      const config = loadConfig();
      const manager = new WorktreeManager(this.repositoryPath, config.paths.workspacesRoot);
      await manager.remove(taskId, { force: true });
      return;
    }
    const response = await fetch(`${this.baseUrl}/sandboxes/${taskId}`, { method: 'DELETE' });
    if (!response.ok) logger.warn('sandbox destroy failed', { taskId, status: response.status });
  }

  async health(): Promise<boolean> {
    if (!this.enabled) return true;
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
