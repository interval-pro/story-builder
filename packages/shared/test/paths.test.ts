import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { stateRootFor } from '../src/paths';

test('state lives beside the installation, never inside it', () => {
  const installRoot = '/Users/someone/.story-builder/cars';
  const stateRoot = stateRootFor(installRoot);
  assert.equal(path.relative(installRoot, stateRoot).startsWith('..'), true);
});

test('two installations do not share a state directory', () => {
  assert.notEqual(
    stateRootFor('/Users/someone/.story-builder/cars'),
    stateRootFor('/Users/someone/.story-builder/boats'),
  );
});

test('a trailing separator does not change where the state goes', () => {
  assert.equal(stateRootFor('/opt/story-builder/'), stateRootFor('/opt/story-builder'));
});
