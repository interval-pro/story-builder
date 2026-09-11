import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readUsage } from '../src/cli.ts';
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
