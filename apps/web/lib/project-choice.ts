interface Choosable {
  id: string;
  kind: 'PROJECT' | 'INSTALLATION';
}

/**
 * Which project the cockpit is showing.
 *
 * The chosen one, looked up among every project including the engine itself.
 * It used to be looked up among projects of your own only, so choosing the
 * engine in the switcher snapped straight back to the first of them, and
 * everything filed under the engine disappeared from lists that filter by the
 * current project. With nothing chosen, or a choice that was removed, the first
 * project of your own comes first, then the engine.
 */
export function chooseProject<T extends Choosable>(projects: T[], selected: string): T | null {
  return (
    projects.find((candidate) => candidate.id === selected) ??
    projects.find((candidate) => candidate.kind === 'PROJECT') ??
    projects.find((candidate) => candidate.kind === 'INSTALLATION') ??
    null
  );
}
