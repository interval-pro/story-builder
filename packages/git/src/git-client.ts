import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '@ai-engine/shared';

const execFileAsync = promisify(execFile);

/** Unit separator, used to make git log output unambiguously parseable. */
const FIELD_SEPARATOR = String.fromCharCode(31);

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommitSummary {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export class GitError extends AppError {
  constructor(command: string, stderr: string, exitCode: number) {
    super('git_failed', `git ${command} failed (exit ${exitCode}): ${stderr.trim()}`, 500, { command, exitCode });
  }
}

/** Thin, explicit wrapper around the Git CLI. No shell interpolation anywhere. */
export class GitClient {
  public readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async run(
    args: string[],
    options: { allowFailure?: boolean; maxBuffer?: number; env?: Record<string, string> } = {},
  ): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: this.cwd,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        // Prompting is disabled everywhere: a headless worker must fail with a
        // readable error instead of blocking on a terminal that is not there.
        env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      if (options.allowFailure) {
        return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code ?? 1 };
      }
      throw new GitError(args.join(' '), failure.stderr ?? String(error), failure.code ?? 1);
    }
  }

  async isRepository(): Promise<boolean> {
    const result = await this.run(['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  async repositoryRoot(): Promise<string> {
    const result = await this.run(['rev-parse', '--show-toplevel']);
    return result.stdout.trim();
  }

  /** Works on a repository with no commits, where HEAD does not resolve yet. */
  async currentBranch(): Promise<string> {
    const result = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
    if (result.exitCode === 0) return result.stdout.trim();
    const symbolic = await this.run(['symbolic-ref', '--short', 'HEAD'], { allowFailure: true });
    return symbolic.exitCode === 0 ? symbolic.stdout.trim() : 'main';
  }

  /** False for a freshly initialised repository that has no commit yet. */
  async hasCommits(): Promise<boolean> {
    const result = await this.run(['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
    return result.exitCode === 0;
  }

  async headCommit(ref = 'HEAD'): Promise<string> {
    const result = await this.run(['rev-parse', ref], { allowFailure: true });
    if (result.exitCode !== 0) {
      throw new GitError(`rev-parse ${ref}`, 'the repository has no commits yet', result.exitCode);
    }
    return result.stdout.trim();
  }

  async resolveRef(ref: string): Promise<string | null> {
    const result = await this.run(['rev-parse', '--verify', ref], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  /**
   * Untracked files are included by default. Callers asking whether the code
   * itself was changed pass includeUntracked: false, because a stray file that
   * no commit knows about does not change what the code does.
   */
  async status(
    options: { includeUntracked?: boolean } = {},
  ): Promise<{ clean: boolean; entries: { status: string; path: string }[] }> {
    const args = ['status', '--porcelain=v1'];
    if (options.includeUntracked === false) args.push('--untracked-files=no');
    const result = await this.run(args);
    const entries = result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
    return { clean: entries.length === 0, entries };
  }

  async log(ref: string, limit = 20): Promise<CommitSummary[]> {
    const format = ['%H', '%an', '%aI', '%s'].join('%x1f');
    const result = await this.run(['log', `-${limit}`, `--pretty=format:${format}`, ref], { allowFailure: true });
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.includes(FIELD_SEPARATOR))
      .map((line) => {
        const [sha = '', author = '', date = '', subject = ''] = line.split(FIELD_SEPARATOR);
        return { sha, author, date, subject };
      });
  }

  /** The tag HEAD sits on, or the most recent one behind it. */
  async describeTag(): Promise<{ tag: string; exact: boolean } | null> {
    const exact = await this.run(['describe', '--tags', '--exact-match'], { allowFailure: true });
    if (exact.exitCode === 0 && exact.stdout.trim()) return { tag: exact.stdout.trim(), exact: true };
    const nearest = await this.run(['describe', '--tags', '--abbrev=0'], { allowFailure: true });
    if (nearest.exitCode === 0 && nearest.stdout.trim()) return { tag: nearest.stdout.trim(), exact: false };
    return null;
  }

  async listTags(): Promise<string[]> {
    const result = await this.run(['tag', '--list', '--sort=-v:refname'], { allowFailure: true });
    if (result.exitCode !== 0) return [];
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  async remoteUrl(remote = 'origin'): Promise<string | null> {
    const result = await this.run(['remote', 'get-url', remote], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async fetch(remote = 'origin', ref?: string): Promise<void> {
    const args = ['fetch', '--prune', remote];
    if (ref) args.push(ref);
    await this.run(args);
  }

  async defaultBranch(): Promise<string> {
    const head = await this.run(['symbolic-ref', 'refs/remotes/origin/HEAD'], { allowFailure: true });
    if (head.exitCode === 0) {
      const name = head.stdout.trim().split('/').pop();
      if (name) return name;
    }
    for (const candidate of ['main', 'master']) {
      const exists = await this.run(['rev-parse', '--verify', candidate], { allowFailure: true });
      if (exists.exitCode === 0) return candidate;
    }
    return this.currentBranch();
  }

  async createBranch(name: string, startPoint: string): Promise<void> {
    await this.run(['branch', name, startPoint]);
  }

  /**
   * Puts the working directory on a branch, creating it if it is not there yet.
   *
   * Two commands rather than one because `git branch` makes a ref and leaves you
   * where you were. Creating without checking out is how a story's writes ended
   * up on the branch the person was sitting on while the story's own branch
   * stayed empty, and nothing about that failure is visible until you look at
   * the diff.
   */
  async switchToBranch(name: string, startPoint: string): Promise<void> {
    if (!(await this.branchExists(name))) await this.createBranch(name, startPoint);
    await this.checkoutBranch(name);
  }

  /**
   * Moves the working directory onto a branch.
   *
   * With no worktrees this is how a story takes the project directory and how it
   * gives it back, so a failure here is a failure to isolate rather than a
   * convenience: it is surfaced rather than swallowed.
   */
  async checkoutBranch(name: string): Promise<void> {
    await this.run(['checkout', name]);
  }

  /**
   * Merges a branch into whatever is checked out, without fast-forwarding.
   *
   * A merge commit is kept deliberately: it is the record that a story ended here,
   * and it is what makes the merge a single commit to undo.
   */
  async mergeBranch(
    name: string,
    message: string,
    author?: { name: string; email: string },
  ): Promise<{ merged: boolean; conflicts: string[]; output: string }> {
    const args = ['merge', '--no-ff', '-m', message, name];
    if (author) args.unshift('-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`);
    const result = await this.run(args, { allowFailure: true });
    if (result.exitCode === 0) return { merged: true, conflicts: [], output: result.stdout };
    const conflicts = await this.run(['diff', '--name-only', '--diff-filter=U'], { allowFailure: true });
    return {
      merged: false,
      conflicts: conflicts.stdout.split('\n').filter((line) => line.trim().length > 0),
      output: `${result.stdout}\n${result.stderr}`.trim(),
    };
  }

  /** Abandons a merge that stopped on conflicts, leaving the branch as it was. */
  async abortMerge(): Promise<void> {
    await this.run(['merge', '--abort'], { allowFailure: true });
  }

  /** Local branches, newest commit first, which is the order a person thinks in. */
  async listBranches(): Promise<string[]> {
    const result = await this.run(['branch', '--format=%(refname:short)', '--sort=-committerdate'], {
      allowFailure: true,
    });
    return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  }

  async branchExists(name: string): Promise<boolean> {
    const result = await this.run(['rev-parse', '--verify', `refs/heads/${name}`], { allowFailure: true });
    return result.exitCode === 0;
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.run(['branch', force ? '-D' : '-d', name], { allowFailure: true });
  }

  async addAll(): Promise<void> {
    await this.run(['add', '-A']);
  }

  async commit(message: string, author?: { name: string; email: string }): Promise<string> {
    const args = ['commit', '-m', message];
    if (author) args.unshift('-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`);
    await this.run(args);
    return this.headCommit();
  }

  async hasStagedChanges(): Promise<boolean> {
    const result = await this.run(['diff', '--cached', '--quiet'], { allowFailure: true });
    return result.exitCode !== 0;
  }

  async rebase(onto: string): Promise<{ success: boolean; conflicts: string[]; output: string }> {
    const result = await this.run(['rebase', onto], { allowFailure: true });
    if (result.exitCode === 0) return { success: true, conflicts: [], output: result.stdout };
    const conflicts = await this.run(['diff', '--name-only', '--diff-filter=U'], { allowFailure: true });
    return {
      success: false,
      conflicts: conflicts.stdout.split('\n').filter((line) => line.trim().length > 0),
      output: `${result.stdout}\n${result.stderr}`,
    };
  }

  async abortRebase(): Promise<void> {
    await this.run(['rebase', '--abort'], { allowFailure: true });
  }

  /**
   * Carries on a rebase whose conflicts have been resolved and staged.
   *
   * A person resolving in their editor leaves exactly this state, and so does an
   * agent. `--no-edit` because the commit message is already the one being
   * replayed and nothing here can open an editor.
   */
  async continueRebase(): Promise<{ success: boolean; conflicts: string[]; output: string }> {
    const result = await this.run(['-c', 'core.editor=true', 'rebase', '--continue'], { allowFailure: true });
    if (result.exitCode === 0) return { success: true, conflicts: [], output: result.stdout };
    return {
      success: false,
      conflicts: await this.unmergedPaths(),
      output: `${result.stdout}\n${result.stderr}`.trim(),
    };
  }

  /** Files git still considers in conflict: the question "is it resolved yet". */
  async unmergedPaths(): Promise<string[]> {
    const result = await this.run(['diff', '--name-only', '--diff-filter=U'], { allowFailure: true });
    return result.stdout.split('\n').filter((line) => line.trim().length > 0);
  }

  /** Whether a rebase or a merge is part-way through, resolved or not. */
  async operationInProgress(): Promise<'rebase' | 'merge' | null> {
    const rebase = await this.run(['rev-parse', '--git-path', 'rebase-merge'], { allowFailure: true });
    const applying = await this.run(['rev-parse', '--git-path', 'rebase-apply'], { allowFailure: true });
    const merging = await this.run(['rev-parse', '--git-path', 'MERGE_HEAD'], { allowFailure: true });
    const exists = async (result: { exitCode: number; stdout: string }): Promise<boolean> => {
      if (result.exitCode !== 0) return false;
      const check = await this.run(['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
      if (check.exitCode !== 0) return false;
      return access(path.resolve(this.cwd, result.stdout.trim()))
        .then(() => true)
        .catch(() => false);
    };
    if (await exists(rebase)) return 'rebase';
    if (await exists(applying)) return 'rebase';
    if (await exists(merging)) return 'merge';
    return null;
  }

  /** Moves a branch back to a commit, discarding what came after it. */
  async resetHard(commit: string): Promise<void> {
    await this.run(['reset', '--hard', commit]);
  }

  /** Commits that exist on `ref` but not on `base`. */
  async commitsAhead(base: string, ref: string): Promise<number> {
    const result = await this.run(['rev-list', '--count', `${base}..${ref}`], { allowFailure: true });
    return result.exitCode === 0 ? Number.parseInt(result.stdout.trim(), 10) || 0 : 0;
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const result = await this.run(['merge-base', a, b], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  /**
   * Pushes a branch. When a token is supplied the credential is injected for
   * this one invocation through an ephemeral helper: the ambient helper is
   * cleared first so a broken or absent keychain cannot be consulted, and the
   * secret never reaches .git/config, the remote URL or the reflog.
   */
  async push(
    remote: string,
    branch: string,
    options: { force?: boolean; token?: string | undefined } = {},
  ): Promise<GitResult> {
    const args: string[] = [];
    if (options.token) {
      args.push(
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=!f() { echo username=x-access-token; echo password="$AI_ENGINE_GIT_TOKEN"; }; f`,
      );
    }
    args.push('push', '--set-upstream', remote, branch);
    if (options.force) args.push('--force-with-lease');

    return this.run(args, {
      allowFailure: true,
      ...(options.token ? { env: { AI_ENGINE_GIT_TOKEN: options.token } } : {}),
    });
  }

  async showFile(ref: string, filePath: string): Promise<string | null> {
    const result = await this.run(['show', `${ref}:${filePath}`], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout : null;
  }

  async listFiles(pattern?: string): Promise<string[]> {
    const args = ['ls-files'];
    if (pattern) args.push(pattern);
    const result = await this.run(args);
    return result.stdout.split('\n').filter((line) => line.trim().length > 0);
  }

  async configure(key: string, value: string): Promise<void> {
    await this.run(['config', key, value]);
  }
}
