import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTaskSize, requiredSectionsFor, reviewBudgetFor } from '../src/task-size';

test('a one file change with no risk signals is small', () => {
  assert.equal(classifyTaskSize({ fileCount: 1, riskSignalCount: 0 }), 'SMALL');
});

test('a risk signal on its own takes a change out of small', () => {
  assert.equal(classifyTaskSize({ fileCount: 1, riskSignalCount: 1 }), 'STANDARD');
});

test('three risk signals make a change large however few files it touches', () => {
  assert.equal(classifyTaskSize({ fileCount: 1, riskSignalCount: 3 }), 'LARGE');
});

test('touching many files makes a change large', () => {
  assert.equal(classifyTaskSize({ fileCount: 11, riskSignalCount: 0 }), 'LARGE');
});

test('a small review asks for fewer sections than a large one', () => {
  const small = requiredSectionsFor('SMALL');
  const large = requiredSectionsFor('LARGE');
  assert.ok(small.length < large.length);
  for (const key of small) assert.ok(large.includes(key), `${key} should still be required at LARGE`);
});

test('every size still demands the sections a human decides from', () => {
  for (const size of ['SMALL', 'STANDARD', 'LARGE'] as const) {
    const required = requiredSectionsFor(size);
    for (const key of ['recommended_approach', 'downsides_tradeoffs', 'implementation_plan'] as const) {
      assert.ok(required.includes(key), `${key} missing at ${size}`);
    }
  }
});

test('the budget grows with the size', () => {
  assert.ok(reviewBudgetFor('SMALL').maxWordsPerSection < reviewBudgetFor('STANDARD').maxWordsPerSection);
  assert.ok(reviewBudgetFor('STANDARD').maxWordsPerSection < reviewBudgetFor('LARGE').maxWordsPerSection);
});
