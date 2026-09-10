import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStructuredAnswer } from '../src/structured-output';

test('a fenced block is read as the answer', () => {
  assert.deepEqual(parseStructuredAnswer('Here it is:\n```json\n{"a": 1}\n```'), { a: 1 });
});

test('an unfenced object surrounded by prose is read as the answer', () => {
  assert.deepEqual(parseStructuredAnswer('Sure.\n{"a": 1}\nThat is all.'), { a: 1 });
});

test('a fenced block that is not the answer falls back to the object in the text', () => {
  const raw = 'First, an example:\n```ts\nconst a = 1;\n```\nAnd the answer:\n{"a": 1}';
  assert.deepEqual(parseStructuredAnswer(raw), { a: 1 });
});

test('malformed JSON is reported as a failed answer, not as a parser error', () => {
  const raw = '{"summary": "he said "hi" there", "b": 1}';
  assert.throws(
    () => parseStructuredAnswer(raw),
    (error: Error & { code?: string }) => error.code === 'structured_output_failed',
  );
});

test('an answer with no object at all is reported the same way', () => {
  assert.throws(
    () => parseStructuredAnswer('I could not do it.'),
    (error: Error & { code?: string }) => error.code === 'structured_output_failed',
  );
});
