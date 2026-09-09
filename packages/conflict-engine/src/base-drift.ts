import { createLogger } from '@ai-engine/shared';
import { GitClient } from '@ai-engine/git';

const logger = createLogger('base-drift');

export interface BaseDriftStatus {
  moved: boolean;
  baseCommit: string;
  remoteHead: string | null;
  commitsBehind: number;
}

/**
 * Tasks are not rebased continuously. The system only records that the base
 * moved, and the integration validation before a pull request does the work.
 */
export async function checkBaseDrift(input: {
  repositoryPath: string;
  baseBranch: string;
  baseCommit: string;
  fetch?: boolean;
}): Promise<BaseDriftStatus> {
  const git = new GitClient(input.repositoryPath);
  if (input.fetch ?? true) {
    try {
      await git.fetch('origin', input.baseBranch);
    } catch (error) {
      logger.warn('fetch failed while checking base drift', { error });
    }
  }

  const remoteHead =
    (await git.resolveRef(`origin/${input.baseBranch}`)) ?? (await git.resolveRef(input.baseBranch));
  if (!remoteHead) {
    return { moved: false, baseCommit: input.baseCommit, remoteHead: null, commitsBehind: 0 };
  }

  const commitsBehind = await git.commitsAhead(input.baseCommit, remoteHead);
  return {
    moved: remoteHead !== input.baseCommit && commitsBehind > 0,
    baseCommit: input.baseCommit,
    remoteHead,
    commitsBehind,
  };
}

export interface IntegrationResult {
  rebased: boolean;
  conflicts: string[];
  newBaseCommit: string | null;
  output: string;
}

/** Rebases the task branch onto the current base before a pull request. */
export async function rebaseOntoBase(input: {
  workspacePath: string;
  baseBranch: string;
}): Promise<IntegrationResult> {
  const git = new GitClient(input.workspacePath);
  try {
    await git.fetch('origin', input.baseBranch);
  } catch (error) {
    logger.warn('fetch failed before rebase', { error });
  }

  const target = (await git.resolveRef(`origin/${input.baseBranch}`)) ? `origin/${input.baseBranch}` : input.baseBranch;
  const result = await git.rebase(target);
  if (!result.success) {
    await git.abortRebase();
    return { rebased: false, conflicts: result.conflicts, newBaseCommit: null, output: result.output };
  }
  const newBaseCommit = await git.resolveRef(target);
  return { rebased: true, conflicts: [], newBaseCommit, output: result.output };
}
