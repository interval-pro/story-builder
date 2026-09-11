import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carryOpenFindings, collectQaNotes, type QaIterationRecord } from '../src/qa-findings.ts';
import type { QaFinding } from '../src/entities.ts';

function finding(id: string, summary: string, file: string | null = null): QaFinding {
  return {
    id,
    category: 'correctness',
    severity: 'blocking',
    file,
    summary,
    detail: 'detail',
    suggestedFix: 'fix it',
    status: 'OPEN',
  };
}

const AT = (minutes: number): string => new Date(Date.parse('2026-09-11T10:00:00.000Z') + minutes * 60_000).toISOString();

test('a single iteration carries its own findings', () => {
  const open = carryOpenFindings({
    qaRuns: [{ iteration: 1, verdict: 'REJECTED', findings: [finding('a', 'Token expiry is untested')], createdAt: AT(10) }],
    fixTimes: [],
  });
  assert.equal(open.length, 1);
  assert.equal(open[0]!.summary, 'Token expiry is untested');
});

test('a second pass over the same code adds to the first rather than replacing it', () => {
  // This is the case that cost a real defect: two QA runs with no fix between
  // them found different things, and reading only the latest dropped the first.
  const open = carryOpenFindings({
    qaRuns: [
      { iteration: 1, verdict: 'REJECTED', findings: [finding('a', 'Null reads as a cold start')], createdAt: AT(10) },
      { iteration: 2, verdict: 'REJECTED', findings: [finding('b', 'Migration lacks a down path')], createdAt: AT(20) },
    ],
    fixTimes: [],
  });
  assert.deepEqual(
    open.map((entry) => entry.summary).sort(),
    ['Migration lacks a down path', 'Null reads as a cold start'],
  );
});

test('a pass that followed a fix treats what it does not raise again as dealt with', () => {
  const open = carryOpenFindings({
    qaRuns: [
      { iteration: 1, verdict: 'REJECTED', findings: [finding('a', 'Null reads as a cold start')], createdAt: AT(10) },
      { iteration: 2, verdict: 'REJECTED', findings: [finding('b', 'Migration lacks a down path')], createdAt: AT(30) },
    ],
    // An implementation ran in between, so iteration 2 judged changed code.
    fixTimes: [AT(20)],
  });
  assert.deepEqual(open.map((entry) => entry.summary), ['Migration lacks a down path']);
});

test('the same defect reported twice is one finding, in its newest wording', () => {
  const open = carryOpenFindings({
    qaRuns: [
      { iteration: 1, verdict: 'REJECTED', findings: [finding('a', 'Token expiry is untested', 'token.ts')], createdAt: AT(10) },
      { iteration: 2, verdict: 'REJECTED', findings: [finding('b', 'token expiry is untested', 'token.ts')], createdAt: AT(20) },
    ],
    fixTimes: [],
  });
  assert.equal(open.length, 1);
  assert.equal(open[0]!.id, 'b');
});

test('an approval clears everything, because the agent whose job is to reject declined to', () => {
  const open = carryOpenFindings({
    qaRuns: [
      { iteration: 1, verdict: 'REJECTED', findings: [finding('a', 'Token expiry is untested')], createdAt: AT(10) },
      { iteration: 2, verdict: 'APPROVED', findings: [], createdAt: AT(30) },
    ],
    fixTimes: [AT(20)],
  });
  assert.deepEqual(open, []);
});

test('a finding raised after an approval is open again', () => {
  const open = carryOpenFindings({
    qaRuns: [
      { iteration: 1, verdict: 'APPROVED', findings: [], createdAt: AT(10) },
      { iteration: 2, verdict: 'REJECTED', findings: [finding('a', 'The rebase broke the migration')], createdAt: AT(40) },
    ],
    fixTimes: [AT(30)],
  });
  assert.deepEqual(open.map((entry) => entry.summary), ['The rebase broke the migration']);
});

test('every finding carried forward is marked open, whatever it was stored as', () => {
  const resolved: QaFinding = { ...finding('a', 'Token expiry is untested'), status: 'RESOLVED' };
  const open = carryOpenFindings({
    qaRuns: [{ iteration: 1, verdict: 'REJECTED', findings: [resolved], createdAt: AT(10) }],
    fixTimes: [],
  });
  assert.equal(open[0]!.status, 'OPEN');
});

test('notes accumulate across iterations and are not cleared by a fix', () => {
  const runs: QaIterationRecord[] = [
    {
      iteration: 1,
      verdict: 'REJECTED',
      findings: [],
      notes: [{ summary: 'The happy-path test proves little', detail: '', file: 'token.spec.ts' }],
      createdAt: AT(10),
    },
    {
      iteration: 2,
      verdict: 'APPROVED',
      findings: [],
      notes: [
        { summary: 'The happy-path test proves little', detail: '', file: 'token.spec.ts' },
        { summary: 'Two address columns will need care in queries', detail: '', file: null },
      ],
      createdAt: AT(40),
    },
  ];
  const notes = collectQaNotes(runs);
  assert.equal(notes.length, 2);
});

test('an unparseable fix time cannot make a finding disappear', () => {
  const open = carryOpenFindings({
    qaRuns: [
      { iteration: 1, verdict: 'REJECTED', findings: [finding('a', 'Token expiry is untested')], createdAt: AT(10) },
      { iteration: 2, verdict: 'REJECTED', findings: [finding('b', 'Migration lacks a down path')], createdAt: AT(30) },
    ],
    fixTimes: ['not a timestamp'],
  });
  assert.equal(open.length, 2);
});
