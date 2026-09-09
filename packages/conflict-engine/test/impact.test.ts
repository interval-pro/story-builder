import assert from 'node:assert/strict';
import { test } from 'node:test';
import { impactFromReview } from '../src/impact.ts';

test('expected files and symbols become write impact', () => {
  const resources = impactFromReview(['src/user.ts'], ['UserService']);
  assert.ok(resources.some((resource) => resource.kind === 'file' && resource.identifier === 'src/user.ts'));
  assert.ok(resources.some((resource) => resource.kind === 'symbol' && resource.identifier === 'UserService'));
  assert.ok(resources.every((resource) => resource.access === 'write'));
});

test('a migration file is also tracked as a migration resource', () => {
  const resources = impactFromReview(['db/migrations/0002_add_column.sql'], []);
  assert.ok(resources.some((resource) => resource.kind === 'migration'));
});

test('an empty review produces no impact', () => {
  assert.deepEqual(impactFromReview([], []), []);
});
