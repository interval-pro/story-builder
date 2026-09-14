import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeParams, toJson } from '../src/sanitize.ts';

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);
const NUL_ESCAPE = '\\' + 'u0000';

/**
 * Postgres stores neither a NUL character in text nor its JSON escape in jsonb,
 * and it refuses the whole statement rather than the one character. An agent
 * that wrote code containing one took down the worker when the tool call was
 * recorded. What is stored instead is the replacement character, so the record
 * survives and still shows that something was there.
 */

test('JSON for a jsonb column never carries the escape Postgres refuses', () => {
  const json = toJson({ file: 'a.ts', content: 'const cleaned = raw.replace(/[' + NUL + ']/g, "");' });
  assert.equal(json.includes(NUL_ESCAPE), false);
  assert.equal(json.includes(NUL), false);
  assert.equal((JSON.parse(json) as { content: string }).content, 'const cleaned = raw.replace(/[' + REPLACEMENT + ']/g, "");');
});

test('the escape written out as ordinary characters in code is left exactly as it was', () => {
  // Six ordinary characters, not a NUL. JSON escapes the backslash, Postgres
  // accepts it, and rewriting it would change the code the agent wrote.
  const code = 'const nul = "' + NUL_ESCAPE + '";';
  assert.equal((JSON.parse(toJson({ code })) as { code: string }).code, code);
});

test('nested values and keys are cleaned too', () => {
  const parsed = JSON.parse(toJson({ list: ['a' + NUL + 'b', { ['k' + NUL]: 'v' + NUL }], n: 1, ok: true, none: null })) as {
    list: [string, Record<string, string>];
    n: number;
    ok: boolean;
    none: null;
  };
  assert.equal(parsed.list[0], 'a' + REPLACEMENT + 'b');
  assert.deepEqual(parsed.list[1], { ['k' + REPLACEMENT]: 'v' + REPLACEMENT });
  assert.equal(parsed.n, 1);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.none, null);
});

test('toJson and JSON.stringify agree whenever there is nothing to clean', () => {
  const value = { a: [1, 'two', { three: 3 }], b: 'text with "quotes" and \\ backslashes', c: null, d: new Date(0) };
  assert.equal(toJson(value), JSON.stringify(value));
});

test('string parameters lose their NUL characters and everything else passes through', () => {
  const buffer = Buffer.from([0, 1, 2]);
  const date = new Date(0);
  const [text, number, nothing, bytes, when] = sanitizeParams(['a' + NUL + 'b', 42, null, buffer, date]);
  assert.equal(text, 'a' + REPLACEMENT + 'b');
  assert.equal(number, 42);
  assert.equal(nothing, null);
  // Bytes are stored as bytea, where a zero byte is perfectly valid.
  assert.equal(bytes, buffer);
  assert.equal(when, date);
});
