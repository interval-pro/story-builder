import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canTransition } from '../src/task-state.ts';
import { RESUMABLE_WINDOW_MS, shouldResumeFailedRun, type ResumeCandidate } from '../src/run-resume.ts';

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

/**
 * The one assumption in this change that cannot be checked from the repository
 * is how long a session stays warm, so it has a single address and this test.
 * The cases are the seams between the buckets, not points in the middle of them.
 */
const NOW = new Date('2026-09-11T12:00:00.000Z');

function failedRun(overrides: Partial<ResumeCandidate> = {}): ResumeCandidate {
  return {
    status: 'FAILED',
    sessionId: 'session-1',
    finishedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    errorMessage: 'The Claude CLI reported an error',
    ...overrides,
  };
}

test('a run that failed inside the window is resumed', () => {
  assert.equal(shouldResumeFailedRun(failedRun(), NOW), true);
});

test('the window is closed at its far edge, not open', () => {
  const atTheEdge = new Date(NOW.getTime() - RESUMABLE_WINDOW_MS).toISOString();
  assert.equal(shouldResumeFailedRun(failedRun({ finishedAt: atTheEdge }), NOW), true);

  const justPast = new Date(NOW.getTime() - RESUMABLE_WINDOW_MS - 1).toISOString();
  assert.equal(shouldResumeFailedRun(failedRun({ finishedAt: justPast }), NOW), false);
});

test('only a failed run is a resume candidate', () => {
  assert.equal(shouldResumeFailedRun(failedRun({ status: 'COMPLETED' }), NOW), false);
  assert.equal(shouldResumeFailedRun(failedRun({ status: 'RUNNING' }), NOW), false);
  assert.equal(shouldResumeFailedRun(null, NOW), false);
});

test('a run with no session has nothing to resume', () => {
  assert.equal(shouldResumeFailedRun(failedRun({ sessionId: null }), NOW), false);
  assert.equal(shouldResumeFailedRun(failedRun({ sessionId: '' }), NOW), false);
});

test('a run with no usable finish time is treated as outside the window', () => {
  assert.equal(shouldResumeFailedRun(failedRun({ finishedAt: null }), NOW), false);
  assert.equal(shouldResumeFailedRun(failedRun({ finishedAt: 'not a date' }), NOW), false);
});

test('a timed-out run is not resumed: that session already spent its whole budget', () => {
  const timedOut = failedRun({ errorMessage: 'The Claude CLI did not finish within 3600000ms' });
  assert.equal(shouldResumeFailedRun(timedOut, NOW), false);
});
