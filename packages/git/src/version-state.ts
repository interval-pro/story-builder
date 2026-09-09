import { GitClient } from './git-client';

export type VersionState = 'up_to_date' | 'behind' | 'diverged' | 'unknown';

export interface InstallationVersion {
  /** Commit the installation currently runs. */
  commit: string;
  /** Release tag the installation was created from, when there is one. */
  tag: string | null;
  /** True when HEAD is exactly the tagged commit. */
  onTag: boolean;
  /** Commits made locally on top of the tag. */
  localCommits: number;
  /** Uncommitted changes in the installation. */
  dirty: boolean;
  /** Latest release published upstream, when it could be read. */
  latestRelease: string | null;
  state: VersionState;
}

/**
 * Local changes are expected: a story can change the installation without ever
 * cutting an upstream release. Divergence is therefore reported, not treated as
 * an error, and it outranks being behind because it is the more specific fact.
 */
export async function readInstallationVersion(
  installRoot: string,
  latestRelease: string | null,
): Promise<InstallationVersion> {
  const git = new GitClient(installRoot);
  if (!(await git.isRepository())) {
    return {
      commit: 'unknown',
      tag: null,
      onTag: false,
      localCommits: 0,
      dirty: false,
      latestRelease,
      state: 'unknown',
    };
  }

  const commit = await git.headCommit();
  const described = await git.describeTag();
  const status = await git.status();
  const dirty = !status.clean;
  const localCommits = described ? await git.commitsAhead(described.tag, 'HEAD') : 0;

  let state: VersionState;
  if (dirty || localCommits > 0) state = 'diverged';
  else if (!latestRelease || !described) state = 'unknown';
  else if (described.tag === latestRelease) state = 'up_to_date';
  else state = 'behind';

  return {
    commit,
    tag: described?.tag ?? null,
    onTag: described?.exact ?? false,
    localCommits,
    dirty,
    latestRelease,
    state,
  };
}
