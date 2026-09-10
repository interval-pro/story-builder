import path from 'node:path';

/**
 * Where an installation keeps the state it must not lose: task worktrees and
 * artifacts. It sits beside the installation rather than inside it, because
 * the installation directory is replaced wholesale when a new version is
 * installed, while the database that indexes this state survives. Keeping the
 * two halves in one place with different lifetimes leaves rows pointing at
 * files that are no longer there.
 */
export function stateRootFor(installRoot: string): string {
  const normalised = path.resolve(installRoot);
  return `${normalised}.state`;
}
