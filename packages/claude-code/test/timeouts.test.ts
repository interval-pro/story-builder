import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resultTimeoutFor } from '../src/timeouts';

test('the pass that writes the answer gets the same budget as the pass that does the work', () => {
  assert.equal(resultTimeoutFor({ timeoutMs: 3_600_000 }), 3_600_000);
});

test('the answer pass can be given its own budget', () => {
  assert.equal(resultTimeoutFor({ timeoutMs: 3_600_000, resultTimeoutMs: 600_000 }), 600_000);
});

test('a short overall budget is not extended for the answer pass', () => {
  assert.equal(resultTimeoutFor({ timeoutMs: 60_000 }), 60_000);
});
