import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveTaskProgress, type ProgressInput } from '../src/task-progress.ts';

const NOW = Date.parse('2026-09-11T12:00:00.000Z');

function run(phase: string, status: 'RUNNING' | 'COMPLETED' | 'FAILED', minutes: [number, number | null]) {
  return {
    id: `${phase}-${minutes[0]}`,
    phase: phase as never,
    status,
    startedAt: new Date(NOW - minutes[0] * 60_000).toISOString(),
    finishedAt: minutes[1] === null ? null : new Date(NOW - minutes[1] * 60_000).toISOString(),
  };
}

function input(overrides: Partial<ProgressInput>): ProgressInput {
  return {
    state: 'ANALYZING',
    qaIteration: 0,
    blockedReason: null,
    failureReason: null,
    runs: [],
    qaRuns: [],
    reviewApproved: false,
    openBlockingDecisions: 0,
    changedFiles: 0,
    now: NOW,
    ...overrides,
  };
}

test('a story nobody has started yet shows every step as still to come', () => {
  const progress = deriveTaskProgress(input({ state: 'DRAFT' }));
  assert.equal(progress.currentIndex, -1);
  assert.equal(progress.percent, 0);
  assert.ok(progress.steps.every((step) => step.status === 'PENDING'));
});

test('the step a run is in reports how long it has been running', () => {
  const progress = deriveTaskProgress(
    input({ state: 'ANALYZING', runs: [run('RESEARCH', 'RUNNING', [7, null])] }),
  );
  const research = progress.steps[0]!;
  assert.equal(research.key, 'research');
  assert.equal(research.status, 'RUNNING');
  assert.equal(research.durationMs, 7 * 60_000);
  assert.equal(progress.currentForMs, 7 * 60_000);
});

test('a plan waiting for approval asks for a person rather than reporting progress', () => {
  const progress = deriveTaskProgress(
    input({
      state: 'REVIEW_READY',
      runs: [run('RESEARCH', 'COMPLETED', [30, 24]), run('REVIEW', 'COMPLETED', [24, 20])],
    }),
  );
  const approval = progress.steps.find((step) => step.key === 'approval')!;
  assert.equal(approval.status, 'WAITING');
  assert.equal(approval.needsYou, true);
  // The two steps before it finished, so the walk behind the gate is done.
  assert.equal(progress.steps[0]!.status, 'DONE');
  assert.equal(progress.steps[1]!.status, 'DONE');
});

test('open blocking decisions are what the approval step says it is waiting on', () => {
  const progress = deriveTaskProgress(input({ state: 'REVIEW_READY', openBlockingDecisions: 2 }));
  const approval = progress.steps.find((step) => step.key === 'approval')!;
  assert.match(approval.detail, /2 decision/);
});

test('a step with no run of its own is skipped rather than claimed as done', () => {
  // Implementation ran, QA ran, and the report was never produced, which is what
  // a task stopped before the final report looks like.
  const progress = deriveTaskProgress(
    input({
      state: 'PUSHING',
      reviewApproved: true,
      runs: [
        run('RESEARCH', 'COMPLETED', [60, 55]),
        run('REVIEW', 'COMPLETED', [55, 50]),
        run('IMPLEMENTATION', 'COMPLETED', [50, 30]),
        run('QA', 'COMPLETED', [30, 20]),
        run('PUSH', 'RUNNING', [1, null]),
      ],
    }),
  );
  const report = progress.steps.find((step) => step.key === 'report')!;
  assert.equal(report.status, 'SKIPPED');
  const push = progress.steps.find((step) => step.key === 'push')!;
  assert.equal(push.status, 'RUNNING');
});

test('a blocked story reports the reason on the step it stopped in', () => {
  const progress = deriveTaskProgress(
    input({
      state: 'BLOCKED',
      blockedReason: 'Push failed: could not resolve host',
      reviewApproved: true,
      runs: [
        run('RESEARCH', 'COMPLETED', [60, 55]),
        run('REVIEW', 'COMPLETED', [55, 50]),
        run('IMPLEMENTATION', 'COMPLETED', [50, 30]),
        run('QA', 'COMPLETED', [30, 20]),
        run('PUSH', 'COMPLETED', [5, 4]),
      ],
    }),
  );
  const push = progress.steps.find((step) => step.key === 'push')!;
  assert.equal(push.status, 'BLOCKED');
  assert.equal(push.detail, 'Push failed: could not resolve host');
  assert.equal(push.needsYou, true);
});

test('an approved review leaves the approval step done however far the story went', () => {
  const progress = deriveTaskProgress(
    input({
      state: 'IMPLEMENTING',
      reviewApproved: true,
      changedFiles: 4,
      runs: [
        run('RESEARCH', 'COMPLETED', [60, 55]),
        run('REVIEW', 'COMPLETED', [55, 50]),
        run('IMPLEMENTATION', 'RUNNING', [10, null]),
      ],
    }),
  );
  assert.equal(progress.steps.find((step) => step.key === 'approval')!.status, 'DONE');
  assert.equal(progress.steps.find((step) => step.key === 'implementation')!.detail, '4 file(s) changed');
});

test('the checks step says which iteration it is on and how it went', () => {
  const progress = deriveTaskProgress(
    input({
      state: 'FIX_REQUIRED',
      reviewApproved: true,
      runs: [
        run('RESEARCH', 'COMPLETED', [60, 55]),
        run('REVIEW', 'COMPLETED', [55, 50]),
        run('IMPLEMENTATION', 'COMPLETED', [50, 30]),
        run('QA', 'COMPLETED', [30, 25]),
      ],
      qaRuns: [
        {
          iteration: 1,
          verdict: 'REJECTED',
          findings: [{ id: 'f1' } as never, { id: 'f2' } as never],
        },
      ],
    }),
  );
  const checks = progress.steps.find((step) => step.key === 'qa')!;
  assert.match(checks.detail, /Iteration 1: rejected, 2 finding/);
});

test('a finished story reports every step behind it and stops counting time', () => {
  const progress = deriveTaskProgress(
    input({
      state: 'COMPLETED',
      reviewApproved: true,
      runs: [
        run('RESEARCH', 'COMPLETED', [60, 55]),
        run('REVIEW', 'COMPLETED', [55, 50]),
        run('IMPLEMENTATION', 'COMPLETED', [50, 30]),
        run('QA', 'COMPLETED', [30, 25]),
        run('FINAL_REPORT', 'COMPLETED', [25, 24]),
        run('INTEGRATION', 'COMPLETED', [20, 18]),
        run('PUSH', 'COMPLETED', [18, 17]),
      ],
    }),
  );
  assert.equal(progress.currentIndex, -1);
  assert.equal(progress.percent, 100);
  // Sixty minutes from the first start to the last finish, not to now.
  assert.equal(progress.elapsedMs, (60 - 17) * 60_000);
});

test('a failure is attributed to the step the task was actually in', () => {
  // The push writes no run row of its own, so a task that failed there was being
  // blamed on the checks: the last step that did leave one behind.
  const progress = deriveTaskProgress(
    input({
      state: 'FAILED',
      previousState: 'PUSHING',
      failureReason: 'Transition PUSHING -> COMPLETED is not allowed',
      reviewApproved: true,
      runs: [
        run('RESEARCH', 'COMPLETED', [90, 85]),
        run('REVIEW', 'COMPLETED', [85, 80]),
        run('IMPLEMENTATION', 'COMPLETED', [80, 40]),
        run('QA', 'COMPLETED', [40, 30]),
      ],
    }),
  );
  const push = progress.steps.find((step) => step.key === 'push')!;
  const checks = progress.steps.find((step) => step.key === 'qa')!;
  assert.equal(push.status, 'FAILED');
  assert.match(push.detail, /not allowed/);
  assert.equal(checks.status, 'DONE');
});

test('without a previous state the walk still falls back to the last step that ran', () => {
  const progress = deriveTaskProgress(
    input({ state: 'FAILED', runs: [run('RESEARCH', 'FAILED', [10, 9])] }),
  );
  assert.equal(progress.steps[0]!.status, 'FAILED');
});

test('a finished story does not report the rebase and the push as skipped', () => {
  // Those two steps do their work with commands and git rather than an agent
  // session, so they leave no run row. The walk looked for a run, found none, and
  // reported a story that had genuinely pushed as having skipped the push.
  const progress = deriveTaskProgress(
    input({
      state: 'COMPLETED',
      reviewApproved: true,
      runs: [
        run('RESEARCH', 'COMPLETED', [90, 85]),
        run('REVIEW', 'COMPLETED', [85, 80]),
        run('IMPLEMENTATION', 'COMPLETED', [80, 40]),
        run('QA', 'COMPLETED', [40, 30]),
      ],
    }),
  );
  assert.equal(progress.steps.find((step) => step.key === 'integration')!.status, 'DONE');
  assert.equal(progress.steps.find((step) => step.key === 'push')!.status, 'DONE');
  // The final report genuinely does not happen for every story, so it stays
  // distinguishable from the two above.
  assert.equal(progress.steps.find((step) => step.key === 'report')!.status, 'SKIPPED');
  assert.equal(progress.percent, 100);
});
