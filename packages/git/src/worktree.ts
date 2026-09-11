import { access, realpath, rm, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createLogger } from '@ai-engine/shared';
import { GitClient } from './git-client';

const logger = createLogger('git-worktree');

async function canonical(target: string): Promise<string> {
  return realpath(target).catch(() => path.resolve(target));
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCommit: string;
}

/**
 * Task isolation is implemented with Git worktrees. The developer's working
 * copy is never touched, and every task gets its own checkout of the base commit.
 */
/**
 * Whether worktrees can actually be written where they are configured to go.
 *
 * The Claude CLI refuses to write to paths it considers sensitive, and its own
 * configuration directory is one of them, so a workspaces root under `~/.claude`
 * produced an agent that read everything, wrote nothing, and reported that it
 * had implemented nothing — four times, because a fix cycle cannot fix a
 * permission. That cost an afternoon to diagnose from the outside and it is a
 * property of a path, so it is checked here rather than discovered.
 *
 * Returns null when the path is usable, and otherwise the sentence to show.
 */
export function workspacesRootProblem(workspacesRoot: string, homeDir: string): string | null {
  const resolved = path.resolve(workspacesRoot);
  const forbidden = [
    { dir: path.join(homeDir, '.claude'), what: "the Claude CLI's own configuration directory" },
    { dir: path.join(homeDir, '.config'), what: 'a configuration directory' },
    { dir: path.join(homeDir, '.ssh'), what: 'a directory holding credentials' },
  ];

  for (const entry of forbidden) {
    if (resolved === entry.dir || resolved.startsWith(`${entry.dir}${path.sep}`)) {
      return (
        `Worktrees are configured under ${resolved}, which is inside ${entry.what}. ` +
        'The agent would be refused every write there and would report that it implemented nothing. ' +
        'Set WORKSPACES_ROOT somewhere else.'
      );
    }
  }
  return null;
}

export class WorktreeManager {
  private readonly git: GitClient;
  private readonly repositoryPath: string;
  private readonly workspacesRoot: string;

  constructor(repositoryPath: string, workspacesRoot: string) {
    this.repositoryPath = repositoryPath;
    this.workspacesRoot = workspacesRoot;
    this.git = new GitClient(repositoryPath);

    // Refused here rather than discovered four fix cycles later: an agent whose
    // worktree sits somewhere the CLI treats as sensitive reads everything,
    // writes nothing, and reports honestly that it implemented nothing. The
    // fix cycle cannot fix a permission, so it simply repeats.
    const problem = workspacesRootProblem(workspacesRoot, homedir());
    if (problem) throw new Error(problem);
  }

  workspacePathFor(taskId: string): string {
    return path.join(this.workspacesRoot, `task-${taskId}`);
  }

  /**
   * A task re-enters a phase more than once: a retry, and every fix after QA.
   * Work in the worktree is not committed until integration, so an existing
   * worktree on the right branch is reused rather than rebuilt. Rebuilding it
   * would silently discard everything the previous run produced.
   */
  async create(input: { taskId: string; branch: string; baseCommit: string }): Promise<WorktreeInfo> {
    const workspacePath = this.workspacePathFor(input.taskId);
    await mkdir(this.workspacesRoot, { recursive: true });

    if (await this.usable(input.taskId, input.branch)) {
      logger.info('reusing the existing worktree', { workspacePath, branch: input.branch });
      return { path: workspacePath, branch: input.branch, baseCommit: input.baseCommit };
    }
    await this.remove(input.taskId, { force: true });

    const branchExists = await this.git.branchExists(input.branch);
    const args = branchExists
      ? ['worktree', 'add', workspacePath, input.branch]
      : ['worktree', 'add', '-b', input.branch, workspacePath, input.baseCommit];
    await this.git.run(args);
    logger.info('worktree created', { workspacePath, branch: input.branch, baseCommit: input.baseCommit });
    return { path: workspacePath, branch: input.branch, baseCommit: input.baseCommit };
  }

  /** Registered, present on disk and on the branch this task works on. */
  private async usable(taskId: string, branch: string): Promise<boolean> {
    if (!(await this.exists(taskId))) return false;
    try {
      await access(this.workspacePathFor(taskId));
    } catch {
      return false;
    }
    const current = await this.clientFor(taskId).currentBranch().catch(() => null);
    return current === branch;
  }

  async exists(taskId: string): Promise<boolean> {
    const listed = await this.list();
    // Git reports the real path. A workspaces root reached through a symlink,
    // which is what a macOS temporary directory is, would otherwise never
    // match the path we hand out.
    const target = await canonical(this.workspacePathFor(taskId));
    for (const entry of listed) {
      if ((await canonical(entry.path)) === target) return true;
    }
    return false;
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
