import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@ai-engine/shared';
import { GitClient } from './git-client';

const logger = createLogger('git-worktree');

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCommit: string;
}

/**
 * Task isolation is implemented with Git worktrees. The developer's working
 * copy is never touched, and every task gets its own checkout of the base commit.
 */
export class WorktreeManager {
  private readonly git: GitClient;

  constructor(private readonly repositoryPath: string, private readonly workspacesRoot: string) {
    this.git = new GitClient(repositoryPath);
  }

  workspacePathFor(taskId: string): string {
    return path.join(this.workspacesRoot, `task-${taskId}`);
  }

  async create(input: { taskId: string; branch: string; baseCommit: string }): Promise<WorktreeInfo> {
    const workspacePath = this.workspacePathFor(input.taskId);
    await mkdir(this.workspacesRoot, { recursive: true });
    await this.remove(input.taskId, { force: true });

    const branchExists = await this.git.branchExists(input.branch);
    const args = branchExists
      ? ['worktree', 'add', workspacePath, input.branch]
      : ['worktree', 'add', '-b', input.branch, workspacePath, input.baseCommit];
    await this.git.run(args);
    logger.info('worktree created', { workspacePath, branch: input.branch, baseCommit: input.baseCommit });
    return { path: workspacePath, branch: input.branch, baseCommit: input.baseCommit };
  }

  async exists(taskId: string): Promise<boolean> {
    const listed = await this.list();
    const target = this.workspacePathFor(taskId);
    return listed.some((entry) => path.resolve(entry.path) === path.resolve(target));
  }

  async list(): Promise<{ path: string; branch: string | null; head: string | null }[]> {
    const result = await this.git.run(['worktree', 'list', '--porcelain'], { allowFailure: true });
    if (result.exitCode !== 0) return [];
    const entries: { path: string; branch: string | null; head: string | null }[] = [];
    let current: { path: string; branch: string | null; head: string | null } | null = null;
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current) entries.push(current);
        current = { path: line.slice('worktree '.length).trim(), branch: null, head: null };
      } else if (line.startsWith('HEAD ') && current) {
        current.head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ') && current) {
        current.branch = line.slice('branch '.length).trim().replace('refs/heads/', '');
      }
    }
    if (current) entries.push(current);
    return entries;
  }

  async remove(taskId: string, options: { force?: boolean } = {}): Promise<void> {
    const workspacePath = this.workspacePathFor(taskId);
    const args = ['worktree', 'remove', workspacePath];
    if (options.force) args.push('--force');
    await this.git.run(args, { allowFailure: true });
    await this.git.run(['worktree', 'prune'], { allowFailure: true });
    await rm(workspacePath, { recursive: true, force: true });
  }

  clientFor(taskId: string): GitClient {
    return new GitClient(this.workspacePathFor(taskId));
  }

  repositoryClient(): GitClient {
    return this.git;
  }
}
