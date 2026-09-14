/**
 * What a page that fetches for itself should show.
 *
 * A page is loading when the data on screen is not the data it asked for, not
 * while a request happens to be in flight. Pages poll every few seconds, and a
 * rule tied to the request would flash a placeholder on every poll; a rule tied
 * to "has loaded once" would show one project's stories under another's name
 * after a switch. So each page names what it is asking for as a key, remembers
 * the key its data was loaded for, and the two are compared.
 *
 * Two things are never loading. A failed first load shows its error rather than
 * a placeholder that never ends. And once the shell has finished, no project at
 * all is its own answer: an installation with nothing registered must not sit on
 * a placeholder forever.
 */
export type LoadPhase = 'loading' | 'failed' | 'ready' | 'no-project';

export function loadPhase({
  shellLoading = false,
  key,
  loadedFor,
  error,
}: {
  /** The shell is still reading the project list, so a null key means nothing yet. */
  shellLoading?: boolean;
  /** What the page is asking for now, or null when there is no project to ask about. */
  key: string | null;
  /** The key the data on screen was loaded for, or null before the first response. */
  loadedFor: string | null;
  error: string | null;
}): LoadPhase {
  if (shellLoading) return 'loading';
  if (key === null) return 'no-project';
  if (loadedFor === key) return 'ready';
  if (error) return 'failed';
  return 'loading';
}
