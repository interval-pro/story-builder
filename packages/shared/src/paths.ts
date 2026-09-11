import path from 'node:path';
import { homedir } from 'node:os';

/**
 * Where an installation keeps what has to be a file.
 *
 * Almost nothing does any more: projects, stories, artifacts and settings live
 * in the database. What is left is the handful of things a database cannot hold
 * because they are needed before it is reachable or after it has gone — how to
 * connect to it, which commit is running, the process ids, a dump taken before a
 * migration, and a scratch copy of an artifact an agent has to be handed as a
 * file.
 *
 * One level, under the home directory, not beside the checkout. The checkout is
 * code and nothing else, so it can be deleted and cloned again without losing
 * anything, which is the whole point.
 */
export function stateRootFor(installRoot: string, homeDir: string = homedir()): string {
  const name = path
    .basename(path.resolve(installRoot))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .toLowerCase();
  // The usual case is one installation and the plain name. A second one, checked
  // out somewhere else under a different directory name, gets its own state
  // beside the first rather than sharing it — still one level down.
  return name === 'story-builder' || name === ''
    ? path.join(homeDir, '.story-builder')
    : path.join(homeDir, `.story-builder-${name}`);
}

export interface StatePaths {
  root: string;
  /** How to reach the database and which ports to listen on. */
  envFile: string;
  /** The commit the running build was made from. */
  buildFile: string;
  /** A pid and a log per service. */
  runDir: string;
  /** A database dump taken immediately before each migration. */
  snapshotsDir: string;
  /** A file written from the database because an agent has to be given a path. */
  tmpDir: string;
}

export function statePaths(stateRoot: string): StatePaths {
  const root = path.resolve(stateRoot);
  return {
    root,
    envFile: path.join(root, 'env'),
    buildFile: path.join(root, 'build.json'),
    runDir: path.join(root, 'run'),
    snapshotsDir: path.join(root, 'snapshots'),
    tmpDir: path.join(root, 'tmp'),
  };
}
