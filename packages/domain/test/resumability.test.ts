import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canTransition } from '../src/task-state.ts';

/**
 * A retried job re-runs its handler from the top. Repeating a transition that
 * already happened must be treated as "already there", never as an error, which
 * is why the handlers call ensureState rather than transition.
 */
test('a state can never transition to itself', () => {
  for (const state of ['ANALYZING', 'IMPLEMENTING', 'QA_RUNNING', 'FIXING'] as const) {
    assert.equal(canTransition(state, state), false, `${state} -> ${state}`);
  }
});

test('a failed task can be sent back to the phase that failed', () => {
  assert.ok(canTransition('FAILED', 'ANALYSIS_QUEUED'));
  assert.ok(canTransition('FAILED', 'IMPLEMENTATION_QUEUED'));
  assert.ok(canTransition('FAILED', 'QA_QUEUED'));
});
