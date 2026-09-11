import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerPassPolicy, isReadOnlyPhase, policyForPhase } from '../src/phase-policy.ts';
import { EXECUTION_PHASES } from '@ai-engine/domain';

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

test('implementation may write and run, but may never push', () => {
  const policy = policyForPhase('IMPLEMENTATION');
  assert.equal(policy.restricted, undefined);
  // `auto` rather than `acceptEdits`: the latter refuses `npm test` in a headless
  // session, which made the instruction to verify the build impossible to follow.
  assert.equal(policy.permissionMode, 'auto');
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

/**
 * The effort each phase runs its work pass at today. Pinned so that holding the
 * effort across a session can be shown to have lowered nothing: the story allows
 * the two passes of one run to stop disagreeing, and forbids buying the saving
 * by reasoning less.
 */
const WORK_PASS_EFFORT = {
  RESEARCH: 'high',
  REVIEW: 'high',
  IMPLEMENTATION: 'xhigh',
  QA: 'xhigh',
  FINAL_REPORT: 'xhigh',
  INTEGRATION: 'xhigh',
  PUSH: 'low',
} as const;

test('no phase reasons less than it did before', () => {
  for (const phase of ALL_PHASES) {
    assert.equal(policyForPhase(phase).effort, WORK_PASS_EFFORT[phase], `${phase} must keep its effort`);
  }
});

test('the answer pass runs at the effort it is given', () => {
  assert.equal(answerPassPolicy({ effort: 'xhigh' }).effort, 'xhigh');
  assert.equal(answerPassPolicy({ effort: 'low' }).effort, 'low');
});

test('both passes of one run ask for the same effort', () => {
  // They share a session. An effort that changes between them rebuilds the
  // prompt cache from scratch, which used to happen on every run of every phase
  // because the work pass set the flag and the answer pass left it off.
  for (const phase of ALL_PHASES) {
    const work = policyForPhase(phase);
    const answer = answerPassPolicy({ effort: work.effort });
    assert.equal(answer.effort, work.effort, `${phase} must not change effort mid-session`);
  }
});

test('an answer pass given no effort sends none, so the CLI keeps its own', () => {
  assert.equal(answerPassPolicy().effort, undefined);
  assert.equal('effort' in answerPassPolicy(), false);
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

test('intake reads the project and cannot write to it', () => {
  // An idea has no task and no branch, so there is nowhere for it to write and
  // the repository it is reading is the owner's actual checkout.
  const policy = policyForPhase('INTAKE');
  assert.equal(policy.restricted, true);
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    assert.ok(policy.disallowedTools?.includes(tool), `${tool} must be denied`);
  }
});

test('the chat window keeps what a person has in their own terminal', () => {
  // Narrowing this would make the chat something other than the terminal it is
  // meant to replace. Only the two denials that reach outside the project stay.
  const policy = policyForPhase('CHAT', { chatPermissionMode: 'acceptEdits' });
  assert.equal(policy.restricted, undefined);
  assert.equal(policy.permissionMode, 'acceptEdits');
  assert.equal(policy.disallowedTools?.includes('Write'), false);
  assert.ok(policy.disallowedTools?.includes('Bash(sudo:*)'));
  assert.ok(policy.disallowedTools?.includes('Bash(rm -rf /:*)'));
  // Pushing is part of a terminal, unlike in the pipeline where it is a gated
  // step the system performs rather than an agent.
  assert.equal(policy.disallowedTools?.includes('Bash(git push:*)'), false);
});

test('a chat session that may only read is told so through the permission mode', () => {
  const policy = policyForPhase('CHAT', { chatPermissionMode: 'dontAsk' });
  assert.equal(policy.permissionMode, 'dontAsk');
});

test('every phase has a policy, so a new one cannot be added without deciding', () => {
  for (const phase of EXECUTION_PHASES) {
    const policy = policyForPhase(phase);
    assert.ok(policy, phase);
    assert.ok(Array.isArray(policy.disallowedTools), phase);
  }
});

test('the phases that must run the build and the tests are allowed to', () => {
  // Measured against CLI 2.1.268: under acceptEdits the agent may write files but
  // `npm test` comes back refused with two recorded denials, because it prompts
  // and a headless session has nobody to prompt. The implementation agent is told
  // to verify the build and the tests, so a mode that cannot run them makes that
  // instruction impossible to follow.
  for (const phase of ['IMPLEMENTATION', 'INTEGRATION'] as const) {
    assert.equal(policyForPhase(phase).permissionMode, 'auto', phase);
  }
});

test('a phase allowed to run commands still cannot push', () => {
  // Verified by running `git push --dry-run` under `auto` with this deny list:
  // refused, with a recorded denial. Pushing stays something the system does after
  // a human approval.
  for (const phase of ['IMPLEMENTATION', 'INTEGRATION'] as const) {
    const denied = policyForPhase(phase).disallowedTools ?? [];
    assert.ok(denied.includes('Bash(git push:*)'), phase);
    assert.ok(denied.includes('Bash(sudo:*)'), phase);
  }
});
