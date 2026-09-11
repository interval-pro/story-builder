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

/**
 * Whether worktrees can actually be written where they are configured to go.
 *
 * The engine runs each agent as a Claude Code session whose working directory is
 * the task worktree. The CLI refuses to write to paths it considers sensitive,
 * and its own configuration directory is one of them, so a workspaces root under
 * `~/.claude` produces an agent that reads everything, writes nothing, and
 * reports that it implemented nothing — four times in a row, because the fix
 * cycle cannot fix a permission.
 *
 * That failure cost an afternoon to diagnose from the outside, and it is a
 * property of a path rather than of anything that happens at run time. So it is
 * checked, named, and surfaced rather than discovered.
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
        `Task worktrees are configured under ${resolved}, which is inside ${entry.what}. ` +
        'The agent would be refused every write there and would report that it implemented nothing. ' +
        'Set WORKSPACES_ROOT somewhere else, such as beside the installation.'
      );
    }
  }
  return null;
}
