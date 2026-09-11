import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumesAgentSlot, isProjectJob, JOB_TYPES } from '../src/job-types.ts';

test('the slot is taken by the work that is actually heavy', () => {
  // The limit exists to bound how many agent sessions and test runs happen at
  // once. These are the ones that are either.
  for (const jobType of ['RESEARCH', 'IMPLEMENTATION', 'FIX', 'QA', 'INTEGRATION_VALIDATION', 'IDEA_INTAKE'] as const) {
    assert.equal(consumesAgentSlot(jobType), true, jobType);
  }
});

test('a chat turn never waits for a slot', () => {
  // A chat turn is a person waiting at a keyboard. Queueing it behind a fix cycle
  // would make the chat useless exactly when the system is busy, which is when
  // someone is most likely to open it.
  assert.equal(consumesAgentSlot('CHAT_TURN'), false);
});

test('rendering a report, pushing a branch and tearing down a worktree take no slot', () => {
  for (const jobType of ['FINAL_REPORT', 'PUSH_AND_PR', 'SANDBOX_TEARDOWN', 'PROJECT_SETUP'] as const) {
    assert.equal(consumesAgentSlot(jobType), false, jobType);
  }
});

test('every job type has an answer for both questions', () => {
  for (const jobType of JOB_TYPES) {
    assert.equal(typeof consumesAgentSlot(jobType), 'boolean', jobType);
    assert.equal(typeof isProjectJob(jobType), 'boolean', jobType);
  }
});

test('the jobs that belong to a project rather than a task are named', () => {
  assert.equal(isProjectJob('PROJECT_SETUP'), true);
  assert.equal(isProjectJob('IDEA_INTAKE'), true);
  assert.equal(isProjectJob('KNOWLEDGE_REFRESH'), true);
  assert.equal(isProjectJob('IMPLEMENTATION'), false);
});
