import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPhase } from '../lib/load-state';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('while the shell is still reading projects, the page is loading whatever it holds', () => {
  assert.equal(loadPhase({ shellLoading: true, key: 'p1', loadedFor: 'p1', error: null }), 'loading');
  assert.equal(loadPhase({ shellLoading: true, key: null, loadedFor: null, error: null }), 'loading');
});

test('with the shell finished and no project, the page is never stuck on a placeholder', () => {
  // The installation with nothing registered: project stays null for good, so a
  // rule based on data arriving would wait forever.
  assert.equal(loadPhase({ shellLoading: false, key: null, loadedFor: null, error: null }), 'no-project');
  assert.equal(loadPhase({ key: null, loadedFor: 'p1', error: null }), 'no-project');
  assert.equal(loadPhase({ key: null, loadedFor: null, error: 'down' }), 'no-project');
});

test('data loaded for the key being asked for is ready', () => {
  assert.equal(loadPhase({ key: 'p1', loadedFor: 'p1', error: null }), 'ready');
});

test('a failed poll after data has loaded keeps the data on screen', () => {
  assert.equal(loadPhase({ key: 'p1', loadedFor: 'p1', error: 'the API is down' }), 'ready');
});

test('before the first response the page is loading, not empty', () => {
  assert.equal(loadPhase({ key: 'p1', loadedFor: null, error: null }), 'loading');
});

test('switching to another key shows loading instead of the previous data', () => {
  assert.equal(loadPhase({ key: 'b', loadedFor: 'a', error: null }), 'loading');
});

test('a failed first load shows the failure, not a placeholder that never ends', () => {
  assert.equal(loadPhase({ key: 'p1', loadedFor: null, error: 'the API is down' }), 'failed');
  assert.equal(loadPhase({ key: 'b', loadedFor: 'a', error: 'the API is down' }), 'failed');
});

test('composite keys differ when any part differs', () => {
  assert.equal(loadPhase({ key: 'p1|file', loadedFor: 'p1|', error: null }), 'loading');
  assert.equal(loadPhase({ key: 'p1|file', loadedFor: 'p1|file', error: null }), 'ready');
});

/**
 * The pages and task tabs this rule was introduced for. Listed rather than
 * discovered, because pages outside that scope still carry loading copy of
 * their own and are a separate change.
 */
const IN_SCOPE = [
  'app/projects/page.tsx',
  'app/queue/page.tsx',
  'app/stories/page.tsx',
  'app/knowledge/page.tsx',
  'app/brain/page.tsx',
  'app/settings/page.tsx',
  'app/ideas/[id]/page.tsx',
  'app/tasks/[id]/page.tsx',
  'components/timeline-view.tsx',
  'components/work-view.tsx',
  'components/report-view.tsx',
  'components/usage-view.tsx',
];

test('every page that fetches for itself decides what to show through the one rule', () => {
  for (const file of IN_SCOPE) {
    const source = readFileSync(path.join(WEB_ROOT, file), 'utf8');
    assert.ok(source.includes('loadPhase('), `${file} does not decide its loading state with loadPhase`);
  }
});

test('no page in scope passes off loading as an empty message', () => {
  for (const file of IN_SCOPE) {
    const source = readFileSync(path.join(WEB_ROOT, file), 'utf8');
    assert.ok(!/<Empty>\s*Reading/.test(source), `${file} shows its loading state as an empty message`);
  }
});
