import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JOB_TYPES, JOB_STATUSES } from '@ai-engine/domain';
import { loadConfig, resetConfigCache } from '@ai-engine/shared';

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

test('a lease too short for the heartbeat to renew is raised to one that is not', () => {
  // The worker renews every max(30s, lease/3). Under 90s the renewal arrives
  // after the lease has already expired, the orchestrator reclaims a job that
  // never stopped, and a second worker starts the same agent in the same
  // worktree. Observed: the implementation agent reported "a concurrent writer is
  // modifying this worktree" and refused to continue, which is the good outcome
  // of a configuration that should not have been accepted.
  process.env['JOB_LEASE_SECONDS'] = '30';
  resetConfigCache();
  assert.equal(loadConfig(true).service.jobLeaseSeconds, 120);

  process.env['JOB_LEASE_SECONDS'] = '1800';
  resetConfigCache();
  assert.equal(loadConfig(true).service.jobLeaseSeconds, 1800);

  delete process.env['JOB_LEASE_SECONDS'];
  resetConfigCache();
  assert.equal(loadConfig(true).service.jobLeaseSeconds, 900);
});

test('the heartbeat interval always fits inside the lease it renews', () => {
  for (const lease of [120, 300, 900, 3600]) {
    const heartbeatMs = Math.max(30_000, Math.floor((lease * 1000) / 3));
    assert.ok(heartbeatMs < lease * 1000, `a ${lease}s lease is renewed every ${heartbeatMs}ms`);
  }
});
