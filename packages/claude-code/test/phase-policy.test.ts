import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerPassPolicy, isReadOnlyPhase, policyForPhase } from '../src/phase-policy.ts';

const ALL_PHASES = ['RESEARCH', 'REVIEW', 'IMPLEMENTATION', 'QA', 'FINAL_REPORT', 'INTEGRATION', 'PUSH'] as const;
const DELEGATION = ['Agent', 'Task', 'SendMessage', 'ListAgents', 'TaskOutput', 'TaskStop'];

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

test('no phase can spawn a subagent or go looking for tools', () => {
  for (const phase of ALL_PHASES) {
    const policy = policyForPhase(phase);
    for (const tool of [...DELEGATION, 'ToolSearch']) {
      assert.ok(policy.disallowedTools?.includes(tool), `${phase} must deny ${tool}`);
    }
  }
});

test('turning subagents on frees delegation only, and leaves every other denial standing', () => {
  for (const phase of ALL_PHASES) {
    const policy = policyForPhase(phase, { allowSubagents: true });
    const base = policyForPhase(phase);
    for (const tool of DELEGATION) {
      assert.ok(!policy.disallowedTools?.includes(tool), `${phase} must no longer deny ${tool}`);
    }
    // Harness discovery is useless in its own right, so the setting never frees it.
    assert.ok(policy.disallowedTools?.includes('ToolSearch'), `${phase} must still deny ToolSearch`);
    assert.equal(policy.restricted, base.restricted, `${phase} must keep its restricted flag`);
    assert.equal(policy.effort, base.effort, `${phase} must keep its reasoning effort`);
    for (const entry of base.disallowedTools ?? []) {
      if (DELEGATION.includes(entry)) continue;
      assert.ok(policy.disallowedTools?.includes(entry), `${phase} must still deny ${entry}`);
    }
  }
});

test('the answer pass denies the same overhead as the work pass', () => {
  const policy = answerPassPolicy();
  assert.equal(policy.restricted, true);
  assert.equal(policy.permissionMode, 'dontAsk');
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']) {
    assert.ok(policy.disallowedTools?.includes(tool), `the answer pass must deny ${tool}`);
  }
  for (const tool of [...DELEGATION, 'ToolSearch']) {
    assert.ok(policy.disallowedTools?.includes(tool), `the answer pass must deny ${tool}`);
  }

  const allowed = answerPassPolicy({ allowSubagents: true });
  assert.ok(!allowed.disallowedTools?.includes('Agent'));
  for (const tool of ['Write', 'Read', 'ToolSearch']) {
    assert.ok(allowed.disallowedTools?.includes(tool), `the answer pass must still deny ${tool}`);
  }
});

test('no phase is allowed to write and push at the same time', () => {
  for (const phase of ALL_PHASES) {
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
