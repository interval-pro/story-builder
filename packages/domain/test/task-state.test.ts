import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowsWorkspaceWrites,
  assertTransition,
  canTransition,
  isHumanGate,
  isTerminal,
  transitionsFrom,
} from '../src/task-state.ts';
import { classifyRisk, requiresSecondApproval } from '../src/risk.ts';
import { capabilitiesForPhase, phaseForState } from '../src/capabilities.ts';

test('the happy path through the lifecycle is allowed', () => {
  const path = [
    'DRAFT',
    'ANALYSIS_QUEUED',
    'ANALYZING',
    'REVIEW_READY',
    'REVIEW_APPROVED',
    'IMPLEMENTATION_QUEUED',
    'IMPLEMENTING',
    'QA_QUEUED',
    'QA_RUNNING',
    'FINAL_REVIEW_READY',
    'PR_APPROVAL_REQUIRED',
    'INTEGRATION_VALIDATION',
    'PUSHING',
    'PR_CREATED',
    'COMPLETED',
  ] as const;

  for (let index = 0; index < path.length - 1; index++) {
    assert.ok(canTransition(path[index]!, path[index + 1]!), `${path[index]} -> ${path[index + 1]}`);
  }
});

test('skipping the approval gate is refused', () => {
  assert.equal(canTransition('REVIEW_READY', 'IMPLEMENTING'), false);
  assert.equal(canTransition('ANALYZING', 'IMPLEMENTATION_QUEUED'), false);
  assert.throws(() => assertTransition('REVIEW_READY', 'PUSHING'), /not allowed/);
});

test('interruptions are reachable from any live state but not from a terminal one', () => {
  assert.ok(canTransition('IMPLEMENTING', 'PAUSING'));
  assert.ok(canTransition('QA_RUNNING', 'STOPPING'));
  assert.ok(canTransition('ANALYZING', 'FAILED'));
  assert.equal(canTransition('COMPLETED', 'PAUSING'), false);
  assert.equal(transitionsFrom('COMPLETED').length, 0);
});

test('a paused task can return to the state it was paused from', () => {
  assert.ok(canTransition('PAUSED', 'IMPLEMENTING'));
  assert.ok(canTransition('PAUSED', 'ANALYZING'));
  assert.equal(canTransition('PAUSED', 'ROLLED_BACK'), false);
});

test('writes are only enabled after approval', () => {
  assert.equal(allowsWorkspaceWrites('ANALYZING'), false);
  assert.equal(allowsWorkspaceWrites('REVIEW_READY'), false);
  assert.equal(allowsWorkspaceWrites('IMPLEMENTING'), true);
  assert.equal(allowsWorkspaceWrites('FIXING'), true);
});

test('human gates and terminal states are classified', () => {
  assert.ok(isHumanGate('REVIEW_READY'));
  assert.ok(isHumanGate('FINAL_REVIEW_READY'));
  assert.equal(isHumanGate('IMPLEMENTING'), false);
  assert.ok(isTerminal('COMPLETED'));
  assert.equal(isTerminal('BLOCKED'), false);
});

test('a single strong indicator makes a change high risk', () => {
  const assessment = classifyRisk([{ indicator: 'database_migration', evidence: 'adds a migration' }]);
  assert.equal(assessment.level, 'HIGH');
  assert.ok(requiresSecondApproval(assessment.level));
});

test('two weaker indicators combine into high risk', () => {
  const assessment = classifyRisk([
    { indicator: 'core_shared_module', evidence: 'touches the shared module' },
    { indicator: 'weak_test_coverage', evidence: 'no tests cover this path' },
  ]);
  assert.equal(assessment.level, 'HIGH');
});

test('a single weak indicator stays medium and no indicators stay low', () => {
  assert.equal(classifyRisk([{ indicator: 'large_blast_radius', evidence: 'many callers' }]).level, 'MEDIUM');
  assert.equal(classifyRisk([]).level, 'LOW');
});

test('research capabilities never include writing', () => {
  const research = capabilitiesForPhase('RESEARCH');
  assert.equal(research.includes('workspace.write'), false);
  assert.equal(research.includes('git.push'), false);
  assert.ok(research.includes('repo.read'));

  const implementation = capabilitiesForPhase('IMPLEMENTATION');
  assert.ok(implementation.includes('workspace.write'));
  assert.equal(implementation.includes('git.push'), false);

  assert.ok(capabilitiesForPhase('PUSH').includes('git.push'));
});

test('QA cannot write even though it runs after implementation', () => {
  const qa = capabilitiesForPhase('QA');
  assert.equal(qa.includes('workspace.write'), false);
  assert.equal(qa.includes('command.run'), false);
  assert.ok(qa.includes('tests.run'));
});

test('states map to the phase whose capabilities they should get', () => {
  assert.equal(phaseForState('ANALYZING'), 'RESEARCH');
  assert.equal(phaseForState('FIXING'), 'IMPLEMENTATION');
  assert.equal(phaseForState('QA_RUNNING'), 'QA');
  assert.equal(phaseForState('REVIEW_READY'), null);
});

test('a blocked task can go back to the push without re-running an agent', () => {
  // A push that fails blocks the task. Every other route out of BLOCKED runs an
  // agent over work that was already finished, which is why the only reachable
  // end used to be STOPPED and the branch had to be pushed by hand.
  assert.equal(canTransition('BLOCKED', 'PUSHING'), true);
  assert.equal(canTransition('BLOCKED', 'INTEGRATION_VALIDATION'), true);
});

test('a failed task can continue from the push or the integration it failed in', () => {
  assert.equal(canTransition('FAILED', 'PUSHING'), true);
  assert.equal(canTransition('FAILED', 'REVIEW_REGENERATING'), true);
});

test('the routes out of a blocked task all lead somewhere that can finish it', () => {
  for (const target of transitionsFrom('BLOCKED')) {
    // Nothing may lead back to BLOCKED itself, and every listed route has to be
    // a state the machine can actually leave.
    if (['PAUSING', 'STOPPING', 'FAILED'].includes(target)) continue;
    assert.ok(transitionsFrom(target).length > 0, `${target} is a dead end`);
  }
});

test('a push can finish without a pull request', () => {
  // Not every finish goes through a pull request: a project with no remote
  // finishes on a local branch, and an installation is never pushed at all. Both
  // paths transitioned PUSHING -> COMPLETED and both threw, which failed the task
  // after every piece of its work had succeeded.
  assert.equal(canTransition('PUSHING', 'COMPLETED'), true);
  assert.equal(canTransition('PUSHING', 'PR_CREATED'), true);
});

test('every state a handler transitions to from PUSHING is reachable', () => {
  // The three endings the push handler writes: a pull request, a local branch or
  // an installation candidate, and a block when the push itself failed.
  for (const target of ['PR_CREATED', 'COMPLETED', 'BLOCKED'] as const) {
    assert.equal(canTransition('PUSHING', target), true, target);
  }
});

test('a retry can continue from the integration it failed in', () => {
  // A task that failed after its pull request was approved failed in the
  // integration or in the push. Sending it back to QA would re-run an agent over
  // a diff that has already been checked and approved.
  assert.equal(canTransition('FAILED', 'INTEGRATION_VALIDATION'), true);
});
