import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accumulateStreamUsage, readUsage } from '../src/cli.ts';
import { withWorkPassSpend } from '../src/pass-failure.ts';
import { AppError } from '@ai-engine/shared';
import { mergeUsage, readModelUsage, readSubagentStats, type PassUsage } from '../src/usage.ts';

function pass(overrides: Partial<PassUsage> = {}): PassUsage {
  return {
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    modelUsage: null,
    subagentStats: null,
    ...overrides,
  };
}

test('both halves of the cache are read, not just the one that bills cheaply', () => {
  const usage = readUsage({
    usage: {
      input_tokens: 12,
      output_tokens: 400,
      cache_read_input_tokens: 180_000,
      cache_creation_input_tokens: 35_000,
    },
  });
  assert.deepEqual(usage, {
    inputTokens: 12,
    outputTokens: 400,
    cacheReadTokens: 180_000,
    cacheCreationTokens: 35_000,
  });
});

test('a payload that reports no usage at all reads as zeros rather than undefined', () => {
  assert.deepEqual(readUsage({}), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
});

test('the model and subagent objects are read under either spelling', () => {
  assert.deepEqual(readModelUsage({ modelUsage: { 'claude-opus-5': { inputTokens: 5 } } }), {
    'claude-opus-5': { inputTokens: 5 },
  });
  assert.deepEqual(readModelUsage({ model_usage: { 'claude-opus-5': { inputTokens: 5 } } }), {
    'claude-opus-5': { inputTokens: 5 },
  });
  assert.deepEqual(readSubagentStats({ subagent_stats: { count: 0 } }), { count: 0 });
  assert.deepEqual(readSubagentStats({ subagentStats: { count: 2 } }), { count: 2 });
});

test('an absent object is null, so "never recorded" is not confused with "none used"', () => {
  assert.equal(readModelUsage({}), null);
  assert.equal(readSubagentStats({}), null);
  // An array is not the object shape either reader expects.
  assert.equal(readSubagentStats({ subagent_stats: [] }), null);
});

test('merging the two passes adds up the tokens and the cost', () => {
  const merged = mergeUsage(
    pass({
      usage: { inputTokens: 10, outputTokens: 2_000, cacheReadTokens: 50_000, cacheCreationTokens: 30_000 },
      costUsd: 1.5,
    }),
    pass({
      usage: { inputTokens: 4, outputTokens: 900, cacheReadTokens: 80_000, cacheCreationTokens: 0 },
      costUsd: 0.25,
    }),
  );
  assert.deepEqual(merged.usage, {
    inputTokens: 14,
    outputTokens: 2_900,
    cacheReadTokens: 130_000,
    cacheCreationTokens: 30_000,
  });
  assert.equal(merged.costUsd, 1.75);
});

test('merging unions the model keys and sums the numeric leaves under them', () => {
  const merged = mergeUsage(
    pass({ modelUsage: { 'claude-opus-5': { inputTokens: 10, outputTokens: 5 } } }),
    pass({ modelUsage: { 'claude-opus-5': { inputTokens: 3 }, 'claude-haiku-4-5': { inputTokens: 7 } } }),
  );
  assert.deepEqual(merged.modelUsage, {
    'claude-opus-5': { inputTokens: 13, outputTokens: 5 },
    'claude-haiku-4-5': { inputTokens: 7 },
  });
});

test('a non-numeric leaf is kept from the first pass rather than coerced', () => {
  const merged = mergeUsage(
    pass({ subagentStats: { label: 'work', count: 1 } }),
    pass({ subagentStats: { label: 'answer', count: 2 } }),
  );
  assert.deepEqual(merged.subagentStats, { label: 'work', count: 3 });
});

test('a pass that reported nothing leaves the other pass exactly as it was', () => {
  const work = pass({
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 },
    costUsd: 2,
    modelUsage: { 'claude-opus-5': { inputTokens: 10 } },
    subagentStats: { count: 0 },
  });
  const merged = mergeUsage(work, pass());
  assert.deepEqual(merged.usage, work.usage);
  assert.equal(merged.costUsd, 2);
  assert.deepEqual(merged.modelUsage, { 'claude-opus-5': { inputTokens: 10 } });
  assert.deepEqual(merged.subagentStats, { count: 0 });

  const reversed = mergeUsage(pass(), work);
  assert.deepEqual(reversed.modelUsage, work.modelUsage);
  assert.deepEqual(reversed.subagentStats, work.subagentStats);
});

test('a run killed before it finishes still knows what the stream reported', () => {
  // The final payload is where usage normally comes from, and a killed process
  // never prints one. Before this, a run that burned an hour of context and was
  // then killed recorded zero, which is how fifteen of thirty-one runs came to
  // show nothing at all.
  let total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const turn of [
    { input_tokens: 4, output_tokens: 120, cache_read_input_tokens: 18_000, cache_creation_input_tokens: 9_000 },
    { input_tokens: 6, output_tokens: 240, cache_read_input_tokens: 27_000, cache_creation_input_tokens: 1_500 },
  ]) {
    total = accumulateStreamUsage(total, { type: 'assistant', message: { usage: turn } } as never);
  }
  assert.deepEqual(total, {
    inputTokens: 10,
    outputTokens: 360,
    cacheReadTokens: 45_000,
    cacheCreationTokens: 10_500,
  });
});

test('only assistant turns carry usage, so nothing else is counted twice', () => {
  const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const afterUser = accumulateStreamUsage(empty, {
    type: 'user',
    message: { usage: { input_tokens: 999 } },
  } as never);
  assert.deepEqual(afterUser, empty);

  const afterResult = accumulateStreamUsage(empty, { type: 'result', usage: { input_tokens: 999 } } as never);
  assert.deepEqual(afterResult, empty);
});

test('an answer pass that fails carries the work pass it resumed', () => {
  // The work pass is the expensive half. Letting its numbers die with the answer
  // pass made a run that got all the way to the last step look free.
  const work = {
    sessionId: 'session-1',
    usage: { inputTokens: 10, outputTokens: 1_000, cacheReadTokens: 50_000, cacheCreationTokens: 20_000 },
    costUsd: 1.5,
    modelUsage: { 'claude-opus-5': { output: 1_000 } },
    subagentStats: null,
  } as never;

  const failure = new AppError('claude_cli_timeout', 'timed out', 504, {
    usage: { inputTokens: 1, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0 },
    costUsd: 0.1,
  });

  const merged = withWorkPassSpend(failure, work) as AppError;
  const details = merged.details!;
  assert.deepEqual(details['usage'], {
    inputTokens: 11,
    outputTokens: 1_005,
    cacheReadTokens: 50_100,
    cacheCreationTokens: 20_000,
  });
  assert.equal(details['costUsd'], 1.6);
  assert.equal(details['sessionId'], 'session-1');
  assert.equal(merged.code, 'claude_cli_timeout');
});

test('an answer pass failure with no usage of its own still reports the work pass', () => {
  const work = {
    sessionId: 'session-2',
    usage: { inputTokens: 0, outputTokens: 900, cacheReadTokens: 400, cacheCreationTokens: 300 },
    costUsd: 0.4,
    modelUsage: null,
    subagentStats: null,
  } as never;
  const merged = withWorkPassSpend(new AppError('claude_cli_failed', 'no result', 502), work) as AppError;
  assert.equal((merged.details!['usage'] as { outputTokens: number }).outputTokens, 900);
});

test('something that is not an engine error is returned untouched', () => {
  const plain = new Error('spawn failed');
  assert.equal(withWorkPassSpend(plain, {} as never), plain);
});
