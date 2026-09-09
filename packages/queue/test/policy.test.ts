import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JOB_TYPES, JOB_STATUSES } from '@ai-engine/domain';

/**
 * The queue itself needs Postgres, so this covers the contract the worker and
 * the orchestrator both rely on.
 */
test('every lifecycle phase has a job type', () => {
  for (const type of ['RESEARCH', 'IMPLEMENTATION', 'QA', 'FIX', 'FINAL_REPORT', 'INTEGRATION_VALIDATION', 'PUSH_AND_PR']) {
    assert.ok(JOB_TYPES.includes(type as never), type);
  }
});

test('job statuses cover the crash recovery states', () => {
  assert.ok(JOB_STATUSES.includes('PENDING'));
  assert.ok(JOB_STATUSES.includes('RUNNING'));
  assert.ok(JOB_STATUSES.includes('FAILED'));
});
