import { AppError } from '@ai-engine/shared';
import { GitClient } from '@ai-engine/git';
import type { JobContext } from './job-context';

/**
 * A story works in the project directory, on a branch of its own.
 *
 * There are no worktrees. That was isolation bought with a full copy of the
 * repository and its dependencies per task: measured here, six megabytes of
 * source and three hundred and fifty of `node_modules`, four of them at once. The
 * isolation only ever protected against two stories running in one project at the
 * same time, and the queue now refuses that outright.
 *
 * What replaces it is a branch and a discipline:
 *
 * - The directory is taken at the start of every job and released at the end, so
 *   whenever nothing is running it sits on the branch the person chose, clean.
 * - Everything the agent produced is committed before the directory is released,
 *   which is what makes switching branches safe and what makes a stopped story
 *   recoverable: its work is on its branch, not in a dirty tree.
 * - Before each run the branch is checked. If someone switched it from an editor,
 *   the run stops rather than writing onto whatever is checked out now.
 */

export interface DirectoryHandover {
  /** The branch the directory was on before this story took it. */
  previousBranch: string;
  /** The branch the story works on. */
  branch: string;
}

const COMMIT_AUTHOR = { name: 'Story Builder', email: 'story-builder@localhost' };

/**
 * Puts the project directory on this story's branch, creating it if needed.
 *
 * Refuses when the tree has uncommitted work. That work belongs to whoever left
 * it there, and neither carrying it onto the story's branch nor committing it
 * under the agent's name is defensible. The message names the files, because the
 * next question is always which ones.
 */
export async function takeDirectory(context: JobContext): Promise<DirectoryHandover> {
  const git = new GitClient(context.project.repoPath);
  const current = await git.currentBranch();

  if (current !== context.task.branchName) {
    const status = await git.status({ includeUntracked: true });
    if (!status.clean) {
      const names = status.entries
        .slice(0, 5)
        .map((entry) => entry.path)
        .join(', ');
      const more = status.entries.length > 5 ? `, and ${status.entries.length - 5} more` : '';
      throw new AppError(
        'working_tree_dirty',
        `${context.project.name} has uncommitted changes, so this story cannot take the directory: ${names}${more}. ` +
          'Commit or stash them and start it again.',
        409,
        { files: status.entries.slice(0, 20).map((entry) => entry.path) },
      );
    }

    // The branch the person was on, recorded once and only once: a later job of
    // the same story must not record the story's own branch as the way back.
    if (!context.task.returnedToBranch) {
      await context.repos.tasks.update(context.task.id, { returnedToBranch: current });
      context.task.returnedToBranch = current;
    }

    await git.switchToBranch(context.task.branchName, context.task.baseCommit);
  }

  return {
    previousBranch: context.task.returnedToBranch ?? context.project.workBranch,
    branch: context.task.branchName,
  };
}

/**
 * Confirms the directory is still on this story's branch.
 *
 * Called before an agent writes anything. A person with the project open in an
 * editor can switch branches at any moment, and an agent that then writes is
 * writing onto someone else's work with no record of why.
 */
export async function assertStillOurs(context: JobContext): Promise<void> {
  const git = new GitClient(context.project.repoPath);
  const current = await git.currentBranch();
  if (current !== context.task.branchName) {
    throw new AppError(
      'directory_taken',
      `${context.project.name} is on ${current}, not on this story's branch ${context.task.branchName}. ` +
        'Something changed the branch while this was running, so nothing was written.',
      409,
      { expected: context.task.branchName, actual: current },
    );
  }
}

/**
 * Commits whatever the agent left and returns the directory to the work branch.
 *
 * Committing first is what makes the switch possible at all, and it is also what
 * makes the work survive: a stopped story leaves a branch, not a half-written
 * directory. A story with nothing to commit still releases.
 */
export async function releaseDirectory(context: JobContext): Promise<{ committed: string | null }> {
  const git = new GitClient(context.project.repoPath);
  const current = await git.currentBranch();
  if (current !== context.task.branchName) return { committed: null };

  const committed = await commitStoryWork(context, git);
  const back = context.task.returnedToBranch ?? context.project.workBranch;
  if (back && back !== context.task.branchName) {
    await git.checkoutBranch(back).catch((error: unknown) => {
      context.logger.warn('could not return the project directory to its branch', {
        branch: back,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return { committed };
}

/**
 * Commits everything in the tree onto the story's branch.
 *
 * Nothing else commits before integration, so uncommitted work only survives
 * while the directory stays on this branch. Committing at the end of each run
 * makes the branch the record instead, which is what lets a retry, a fix or a
 * merge continue from the work rather than from the base commit.
 */
export async function commitStoryWork(context: JobContext, git?: GitClient): Promise<string | null> {
  const client = git ?? new GitClient(context.project.repoPath);
  await client.addAll();
  if (!(await client.hasStagedChanges())) return null;
  return client.commit(`ai: ${context.story.title}`.slice(0, 100), COMMIT_AUTHOR);
}
