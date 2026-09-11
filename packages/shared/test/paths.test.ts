import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { statePaths, stateRootFor } from '../src/paths.ts';

test('the state directory is one level under the home directory, never nested twice', () => {
  const root = stateRootFor('/Users/someone/work/story-builder', '/Users/someone');
  assert.equal(root, '/Users/someone/.story-builder');
  // The failure this guards against is ~/.story-builder/story-builder: one
  // directory named after the product, inside another named after the product.
  assert.equal(path.basename(path.dirname(root)), 'someone');
});

test('a second installation under a different directory name gets its own state', () => {
  assert.equal(stateRootFor('/opt/story-builder-two', '/home/me'), '/home/me/.story-builder-story-builder-two');
  assert.notEqual(stateRootFor('/opt/boats', '/home/me'), stateRootFor('/opt/cars', '/home/me'));
});

test('a trailing slash and capitals name the same directory', () => {
  assert.equal(stateRootFor('/opt/Story-Builder/', '/home/me'), stateRootFor('/opt/story-builder', '/home/me'));
});

test('every file the system keeps outside the database sits directly in that directory', () => {
  const paths = statePaths('/home/me/.story-builder');
  assert.equal(paths.envFile, '/home/me/.story-builder/env');
  assert.equal(paths.buildFile, '/home/me/.story-builder/build.json');
  assert.equal(paths.runDir, '/home/me/.story-builder/run');
  assert.equal(paths.snapshotsDir, '/home/me/.story-builder/snapshots');
  assert.equal(paths.tmpDir, '/home/me/.story-builder/tmp');
});
