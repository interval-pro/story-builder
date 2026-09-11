import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTokenUsage, emptyTokenUsage, totalTokens, weeklyUsage, WEEK_MS } from '../src/usage.ts';
import { SETTING_DESCRIPTORS, SETTING_KEYS, settingAsBoolean, settingAsInteger, settingDescriptor } from '../src/settings.ts';

test('a total counts cache movement, because that is where almost all of it is', () => {
  // Measured shape of a real task: 90M read and 4M written against 360k output.
  const usage = {
    inputTokens: 676,
    outputTokens: 358_695,
    cacheReadTokens: 90_177_500,
    cacheCreationTokens: 4_194_361,
  };
  assert.equal(totalTokens(usage), 94_731_232);
  // A total that counted only input and output would be off by two orders of
  // magnitude, which is what makes leaving them out indefensible.
  assert.ok(totalTokens(usage) > 100 * (usage.inputTokens + usage.outputTokens));
});

test('adding usage sums every column and leaves the inputs alone', () => {
  const a = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 };
  const b = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 };
  assert.deepEqual(addTokenUsage(a, b), {
    inputTokens: 11,
    outputTokens: 22,
    cacheReadTokens: 33,
    cacheCreationTokens: 44,
  });
  assert.equal(a.inputTokens, 1);
});

test('an empty usage is zero rather than absent, so a sum can start from it', () => {
  assert.equal(totalTokens(emptyTokenUsage()), 0);
});

test('the week reports a percentage only when a budget was set', () => {
  const usage = { inputTokens: 0, outputTokens: 1_000, cacheReadTokens: 9_000, cacheCreationTokens: 0 };
  const withBudget = weeklyUsage({ usage, runs: 3, unrecordedRuns: 0, budgetTokens: 100_000 });
  assert.equal(withBudget.usedTokens, 10_000);
  assert.equal(withBudget.percentOfBudget, 10);

  const without = weeklyUsage({ usage, runs: 3, unrecordedRuns: 0, budgetTokens: null });
  assert.equal(without.percentOfBudget, null);
});

test('the window is exactly seven days back from the clock it was given', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  const week = weeklyUsage({ usage: emptyTokenUsage(), runs: 0, unrecordedRuns: 0, budgetTokens: null, now });
  assert.equal(Date.parse(week.until), now);
  assert.equal(Date.parse(week.since), now - WEEK_MS);
});

test('nothing reports an engine limit unless the engine reported one', () => {
  const week = weeklyUsage({ usage: emptyTokenUsage(), runs: 0, unrecordedRuns: 0, budgetTokens: 50 });
  assert.equal(week.reportedLimit, null);

  const reported = weeklyUsage({
    usage: emptyTokenUsage(),
    runs: 0,
    unrecordedRuns: 0,
    budgetTokens: null,
    reportedLimit: { weekly_remaining: 12 },
  });
  assert.deepEqual(reported.reportedLimit, { weekly_remaining: 12 });
});

test('every setting descriptor has a default that parses as its own kind', () => {
  for (const descriptor of SETTING_DESCRIPTORS) {
    if (descriptor.kind === 'integer') {
      assert.ok(Number.isFinite(Number.parseInt(descriptor.defaultValue, 10)), `${descriptor.key} default`);
    }
    if (descriptor.kind === 'choice') {
      assert.ok(
        descriptor.choices?.some((choice) => choice.value === descriptor.defaultValue),
        `${descriptor.key} default is one of its choices`,
      );
    }
    assert.ok(descriptor.help.length > 40, `${descriptor.key} explains itself`);
  }
});

test('an integer setting is clamped to its own range rather than trusted', () => {
  const concurrency = settingDescriptor(SETTING_KEYS.queueConcurrency)!;
  assert.equal(settingAsInteger('99', concurrency), concurrency.max);
  assert.equal(settingAsInteger('0', concurrency), concurrency.min);
  assert.equal(settingAsInteger('3', concurrency), 3);
  // Nonsense falls back to the default rather than to zero, which would stop the
  // queue entirely.
  assert.equal(settingAsInteger('not a number', concurrency), Number.parseInt(concurrency.defaultValue, 10));
  assert.equal(settingAsInteger(undefined, concurrency), Number.parseInt(concurrency.defaultValue, 10));
});

test('a boolean setting reads the spellings a person actually types', () => {
  const paused = settingDescriptor(SETTING_KEYS.queuePaused)!;
  for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
    assert.equal(settingAsBoolean(value, paused), true, value);
  }
  for (const value of ['false', '0', 'no', '', 'anything else']) {
    assert.equal(settingAsBoolean(value, paused), false, value);
  }
});
