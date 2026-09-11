import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitClient } from './git-client';

/**
 * Which commit the running build was made from.
 *
 * The checkout moves whenever anyone commits to it, including the system's own
 * stories. What is actually running is whatever was last built, and those two
 * facts drift apart constantly. Recording the built commit is what makes the
 * difference visible instead of mysterious, and it is also the rollback target:
 * one commit, known good because it is the one that was running.
 */
export interface BuildRecord {
  commit: string;
  /** The tag that commit carried, when it had one. */
  tag: string | null;
  builtAt: string;
  /** Which action produced this build: a rebuild from local commits, or a release. */
  source: 'LOCAL' | 'UPSTREAM' | 'INSTALL';
}

export async function readBuildRecord(buildFile: string): Promise<BuildRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(buildFile, 'utf8')) as Partial<BuildRecord>;
    if (typeof parsed.commit !== 'string' || parsed.commit === '') return null;
    return {
      commit: parsed.commit,
      tag: typeof parsed.tag === 'string' ? parsed.tag : null,
      builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : new Date(0).toISOString(),
      source: parsed.source === 'UPSTREAM' || parsed.source === 'INSTALL' ? parsed.source : 'LOCAL',
    };
  } catch {
    // Absent or unreadable means the same thing to every caller: nothing is known
    // about what is running, so everything is reported as unbuilt rather than as
    // up to date.
    return null;
  }
}

export async function writeBuildRecord(buildFile: string, record: BuildRecord): Promise<void> {
  await mkdir(path.dirname(buildFile), { recursive: true });
  await writeFile(buildFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export interface BuildStatus {
  /** The commit the running processes were built from, when it is known. */
  builtCommit: string | null;
  builtAt: string | null;
  headCommit: string;
  /** Commits in the checkout that are not in the running build. */
  commitsAhead: number;
  /** True when the checkout has changes the running processes do not have. */
  hasUnbuiltChanges: boolean;
  /** Uncommitted work in the checkout, which no build would pick up either. */
  dirty: boolean;
  /** The newest release upstream, when it could be read, and whether it is newer. */
  latestRelease: string | null;
  releaseIsNewer: boolean;
  currentTag: string | null;
}

/**
 * The two indicators, kept apart because they are two independent facts.
 *
 * "There are changes here that are not running" is about this machine. "There is
 * a newer release" is about upstream. Conflating them produces the familiar
 * update badge that means nothing in particular; keeping them apart lets the
 * screen say which of the two it is and offer the right action.
 */
export async function readBuildStatus(input: {
  installRoot: string;
  buildFile: string;
  latestRelease?: string | null;
}): Promise<BuildStatus> {
  const git = new GitClient(input.installRoot);
  const record = await readBuildRecord(input.buildFile);
  const headCommit = await git.headCommit();
  const described = await git.describeTag();
  const status = await git.status({ includeUntracked: false });
  const latestRelease = input.latestRelease ?? null;

  const commitsAhead = record && record.commit !== headCommit ? await git.commitsAhead(record.commit, 'HEAD').catch(() => 1) : 0;

  return {
    builtCommit: record?.commit ?? null,
    builtAt: record?.builtAt ?? null,
    headCommit,
    commitsAhead,
    hasUnbuiltChanges: record === null || record.commit !== headCommit || !status.clean,
    dirty: !status.clean,
    latestRelease,
    releaseIsNewer: Boolean(latestRelease && described?.tag !== latestRelease),
    currentTag: described?.tag ?? null,
  };
}
