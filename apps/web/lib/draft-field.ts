/**
 * The submit path for a multi-line draft reads the element itself rather than
 * React state, so a re-render from a poll can never hand it stale text.
 *
 * The target is structural rather than an HTMLTextAreaElement so the policy can
 * be exercised by a plain node:test, which has no DOM.
 */
export interface DraftTarget {
  value: string;
}

/** What the submit path sends. An absent element reads as empty rather than throwing. */
export function readDraft(target: DraftTarget | null): string {
  return target ? target.value : '';
}

/** Empties the element after a successful post. A no-op when the element is gone. */
export function clearDraft(target: DraftTarget | null): void {
  if (target) target.value = '';
}
