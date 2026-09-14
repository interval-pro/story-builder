import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseProject } from '../lib/project-choice';

const installation = { id: 'engine', kind: 'INSTALLATION' as const };
const mimir = { id: 'mimir', kind: 'PROJECT' as const };
const other = { id: 'other', kind: 'PROJECT' as const };

test('the installation can be chosen even when projects of your own exist', () => {
  // The failure this guards against: choosing the engine in the switcher
  // silently snapped back to the first project, because the choice was looked
  // up among work projects only. Everything created while the engine was the
  // default then vanished from the lists, since they filter by that project.
  assert.equal(chooseProject([installation, mimir], 'engine')?.id, 'engine');
});

test('a chosen project of your own is kept', () => {
  assert.equal(chooseProject([installation, mimir, other], 'other')?.id, 'other');
});

test('with nothing chosen, the first project of your own comes before the engine', () => {
  assert.equal(chooseProject([installation, mimir, other], '')?.id, 'mimir');
});

test('a remembered project that was removed falls back rather than pointing at nothing', () => {
  assert.equal(chooseProject([installation, mimir], 'deleted')?.id, 'mimir');
});

test('with no projects of your own, the engine is what there is', () => {
  assert.equal(chooseProject([installation], '')?.id, 'engine');
  assert.equal(chooseProject([], ''), null);
});
