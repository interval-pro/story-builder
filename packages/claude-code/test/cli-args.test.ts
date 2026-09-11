import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildArgs } from '../src/cli.ts';
import { answerPassPolicy, policyForPhase } from '../src/phase-policy.ts';
import type { ClaudeCliOptions } from '../src/types.ts';

const BASE: ClaudeCliOptions = {
  cwd: '/workspace/task-1',
  prompt: 'do the work',
  timeoutMs: 60_000,
};

/** The value that follows a flag, or null when the flag is absent. */
function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
}

test('a session is opened with --session-id and continued with --resume', () => {
  const cold = buildArgs({ ...BASE, sessionId: 'generated-id' }, 'json');
  assert.equal(valueAfter(cold, '--session-id'), 'generated-id');
  assert.equal(cold.includes('--resume'), false);

  const warm = buildArgs({ ...BASE, resumeSessionId: 'earlier-id' }, 'json');
  assert.equal(valueAfter(warm, '--resume'), 'earlier-id');
  assert.equal(warm.includes('--session-id'), false);
});

test('resuming wins over opening, so a resumed run never starts a second session', () => {
  const args = buildArgs({ ...BASE, sessionId: 'generated-id', resumeSessionId: 'earlier-id' }, 'json');
  assert.equal(valueAfter(args, '--resume'), 'earlier-id');
  assert.equal(args.includes('--session-id'), false);
});

test('both passes of one run carry the same --effort', () => {
  const work = policyForPhase('REVIEW');
  const workArgs = buildArgs({ ...BASE, sessionId: 'a', ...work }, 'stream-json');
  const answerArgs = buildArgs({ ...BASE, resumeSessionId: 'a', ...answerPassPolicy({ effort: work.effort }) }, 'json');

  assert.equal(valueAfter(workArgs, '--effort'), 'high');
  assert.equal(valueAfter(answerArgs, '--effort'), 'high');
});

test('each additional directory gets its own --add-dir', () => {
  const args = buildArgs({ ...BASE, additionalDirectories: ['/state/artifacts/p/t', '/state/other'] }, 'json');
  const dirs = args.filter((_, index) => args[index - 1] === '--add-dir');

  assert.deepEqual(dirs, ['/state/artifacts/p/t', '/state/other']);
  assert.equal(args.filter((arg) => arg === '--add-dir').length, 2);
});

test('the stream format asks for the verbose output the events are read from', () => {
  assert.ok(buildArgs(BASE, 'stream-json').includes('--verbose'));
  assert.equal(buildArgs(BASE, 'json').includes('--verbose'), false);
});
