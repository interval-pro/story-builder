import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJson, truncate, countLines, indent } from '../src/text.ts';
import { backoffMs, retry } from '../src/time.ts';
import { slugify, sha256, shortHash } from '../src/ids.ts';

test('JSON is extracted from a fenced block', () => {
  const raw = 'Here you go:\n```json\n{"a": 1}\n```\nThat is all.';
  assert.equal(extractJson(raw), '{"a": 1}');
});

test('JSON is extracted from raw text with balanced braces', () => {
  const raw = 'prefix {"a": {"b": "}"}} suffix';
  assert.equal(extractJson(raw), '{"a": {"b": "}"}}');
});

test('text without JSON returns null', () => {
  assert.equal(extractJson('no object here'), null);
});

test('long output is truncated in the middle and reports the original length', () => {
  const value = 'x'.repeat(1000);
  const result = truncate(value, 100);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, 1000);
  assert.ok(result.text.includes('truncated'));
  assert.ok(result.text.length < 300);
});

test('short output is returned unchanged', () => {
  const result = truncate('hello', 100);
  assert.equal(result.text, 'hello');
  assert.equal(result.truncated, false);
});

test('backoff grows and stays within the cap', () => {
  const first = backoffMs(1, 1000);
  const later = backoffMs(6, 1000);
  assert.ok(first < later);
  assert.ok(later <= 5 * 60_000);
});

test('retry gives up after the configured attempts', async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw new Error('nope');
      },
      { attempts: 3, baseMs: 1 },
    ),
    /nope/,
  );
  assert.equal(calls, 3);
});

test('retry returns the first successful result', async () => {
  let calls = 0;
  const value = await retry(
    async () => {
      calls++;
      if (calls < 2) throw new Error('later');
      return 'ok';
    },
    { attempts: 3, baseMs: 1 },
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 2);
});

test('branch slugs are safe and bounded', () => {
  assert.equal(slugify('Send verification email on change!'), 'send-verification-email-on-change');
  assert.ok(slugify('x'.repeat(200)).length <= 48);
  assert.equal(slugify('!!!'), 'story');
});

test('hashes are stable', () => {
  assert.equal(sha256('a'), sha256('a'));
  assert.notEqual(sha256('a'), sha256('b'));
  assert.equal(shortHash('a').length, 12);
});

test('line counting and indentation behave', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(indent('a\nb', 2), '  a\n  b');
});
