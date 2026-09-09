import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReadOnlyPhase, policyForPhase } from '../src/phase-policy.ts';

test('the analysis phases cannot edit or run anything', () => {
  for (const phase of ['RESEARCH', 'REVIEW'] as const) {
    const policy = policyForPhase(phase);
    assert.equal(policy.restricted, true, `${phase} must be restricted`);
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      assert.ok(policy.disallowedTools?.includes(tool), `${phase} must deny ${tool}`);
    }
  }
});

test('QA reviews the diff without being able to change it', () => {
  const policy = policyForPhase('QA');
  assert.equal(policy.restricted, true);
  assert.ok(policy.disallowedTools?.includes('Write'));
  assert.ok(policy.disallowedTools?.includes('Edit'));
});

test('implementation may write but may never push', () => {
  const policy = policyForPhase('IMPLEMENTATION');
  assert.equal(policy.restricted, undefined);
  assert.equal(policy.permissionMode, 'acceptEdits');
  assert.ok(policy.disallowedTools?.some((entry) => entry.includes('git push')));
  assert.ok(policy.disallowedTools?.some((entry) => entry.includes('git remote')));
  assert.ok(policy.disallowedTools?.some((entry) => entry.includes('sudo')));
  assert.ok(policy.disallowedTools?.some((entry) => entry.includes('docker')));
});

test('no phase is allowed to write and push at the same time', () => {
  for (const phase of ['RESEARCH', 'REVIEW', 'IMPLEMENTATION', 'QA', 'FINAL_REPORT', 'INTEGRATION', 'PUSH'] as const) {
    const policy = policyForPhase(phase);
    const canWrite = !policy.restricted && !policy.disallowedTools?.includes('Write');
    const canPush = !policy.disallowedTools?.some((entry) => entry.includes('git push'));
    assert.equal(canWrite && canPush, false, `${phase} must not be able to both write and push`);
  }
});

test('the read-only phases are exactly the ones that produce documents', () => {
  assert.equal(isReadOnlyPhase('RESEARCH'), true);
  assert.equal(isReadOnlyPhase('QA'), true);
  assert.equal(isReadOnlyPhase('IMPLEMENTATION'), false);
  assert.equal(isReadOnlyPhase('INTEGRATION'), false);
});
