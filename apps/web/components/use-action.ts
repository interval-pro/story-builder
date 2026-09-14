'use client';

import { useState } from 'react';
import { createActionRunner, type ActionState } from '../lib/action';

/**
 * One action at a time per view: which button is waiting, and why the last one
 * did not go through. The runner is made once, lazily, so strict mode's discarded
 * render never leaves a second one behind.
 */
export function useAction() {
  const [state, setState] = useState<ActionState>({ pending: null, error: null });
  const [runner] = useState(() => createActionRunner(setState));
  return {
    pending: state.pending,
    error: state.error,
    busy: state.pending !== null,
    run: runner.run,
    report: runner.report,
    clear: runner.clear,
  };
}
