/**
 * The lifecycle of a button that sends something.
 *
 * Every screen used to hand-roll its own busy flag, and each one got a different
 * part of it wrong: failures nobody saw, errors a poll erased, refreshes that were
 * not waited for, and no record of which button had been clicked. This is the
 * one place that owns it, kept free of React so node:test can exercise it.
 */
export interface ActionState {
  /** The key of the action waiting on its request, or null when none is. */
  pending: string | null;
  /** Why the last action did not go through, or a validation message. */
  error: string | null;
}

export interface ActionRunner {
  /**
   * Runs `work` as the action `key`. Resolves `false` without calling `work` when
   * another action is still in flight, and `false` when `work` throws. Never rejects.
   */
  run: (key: string, label: string, work: () => Promise<unknown>) => Promise<boolean>;
  /** Shows a message without sending anything, such as a validation failure. */
  report: (message: string) => void;
  /** Clears the error. A request still in flight stays pending until it settles. */
  clear: () => void;
}

export function describeFailure(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${label} did not go through: ${message}`;
}

export function createActionRunner(publish: (state: ActionState) => void): ActionRunner {
  // Held here rather than read from React, so a second click is refused
  // synchronously, before React has committed `disabled`.
  let pending: string | null = null;

  return {
    async run(key, label, work) {
      if (pending !== null) return false;
      pending = key;
      publish({ pending, error: null });
      let error: string | null = null;
      try {
        await work();
      } catch (thrown) {
        error = describeFailure(label, thrown);
      } finally {
        pending = null;
        publish({ pending, error });
      }
      return error === null;
    },
    report(message) {
      publish({ pending, error: message });
    },
    clear() {
      publish({ pending, error: null });
    },
  };
}
