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
