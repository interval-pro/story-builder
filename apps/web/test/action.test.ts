import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActionRunner, type ActionState } from '../lib/action';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function recorder() {
  const states: ActionState[] = [];
  const runner = createActionRunner((state) => states.push(state));
  return { states, runner, last: () => states[states.length - 1] };
}

test('a successful action is pending while it waits and clears when it settles', async () => {
  const { states, runner } = recorder();
  let calls = 0;

  const result = await runner.run('pause', 'Pausing', async () => {
    calls += 1;
  });

  assert.equal(result, true);
  assert.equal(calls, 1);
  assert.deepEqual(states, [
    { pending: 'pause', error: null },
    { pending: null, error: null },
  ]);
});

test('a failed action clears its pending state, says it failed and does not reject', async () => {
  const { runner, last } = recorder();

  const result = await runner.run('pause', 'Pausing', async () => {
    throw new Error('nope');
  });

  assert.equal(result, false);
  assert.deepEqual(last(), { pending: null, error: 'Pausing did not go through: nope' });
});

test('a thrown value that is not an Error is still described', async () => {
  const { runner, last } = recorder();

  await runner.run('stop', 'Stopping', async () => {
    throw 'the API is down';
  });
  assert.equal(last().error, 'Stopping did not go through: the API is down');

  await runner.run('stop', 'Stopping', async () => {
    throw { toString: () => 'odd object' };
  });
  assert.equal(last().error, 'Stopping did not go through: odd object');
});

test('a second click while the first request is in flight sends nothing', async () => {
  const { runner, last } = recorder();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let secondCalled = false;

  const first = runner.run('approve', 'Approving', () => gate);
  const second = await runner.run('approve', 'Approving', async () => {
    secondCalled = true;
  });

  assert.equal(second, false);
  assert.equal(secondCalled, false);
  assert.deepEqual(last(), { pending: 'approve', error: null });

  release();
  assert.equal(await first, true);

  let thirdCalled = false;
  assert.equal(
    await runner.run('approve', 'Approving', async () => {
      thirdCalled = true;
    }),
    true,
  );
  assert.equal(thirdCalled, true);
});

test('starting a new action clears the previous failure', async () => {
  const { states, runner } = recorder();

  await runner.run('pause', 'Pausing', async () => {
    throw new Error('nope');
  });
  const before = states.length;
  await runner.run('resume', 'Resuming', async () => {});

  assert.deepEqual(states[before], { pending: 'resume', error: null });
});

test('report shows a message without anything pending, and clear removes it', () => {
  const { runner, last } = recorder();

  runner.report('Write the note first.');
  assert.deepEqual(last(), { pending: null, error: 'Write the note first.' });

  runner.clear();
  assert.deepEqual(last(), { pending: null, error: null });
});

function tsxFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

test('no screen in the cockpit hand-rolls its own busy flag', () => {
  // A local busy flag is how failures went unseen, errors were erased by polls
  // and nobody could tell which button had been clicked. useAction owns that now.
  const offenders = tsxFiles(WEB_ROOT)
    .filter((file) => readFileSync(file, 'utf8').includes('setBusy('))
    .map((file) => path.relative(WEB_ROOT, file));

  assert.deepEqual(offenders, []);
});

test('a pending button shows a spinner and says it is busy', () => {
  const ui = readFileSync(path.join(WEB_ROOT, 'components/ui.tsx'), 'utf8');

  assert.match(ui, /export function Spinner\(/);
  assert.match(ui, /aria-busy=/);
});

test('the spinner stands still for people who asked for reduced motion', () => {
  const css = readFileSync(path.join(WEB_ROOT, 'app/globals.css'), 'utf8');
  const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.notEqual(start, -1);

  let depth = 0;
  let end = css.indexOf('{', start);
  for (; end < css.length; end += 1) {
    if (css[end] === '{') depth += 1;
    else if (css[end] === '}' && --depth === 0) break;
  }

  assert.match(css.slice(start, end), /\.spinner\s*\{[^}]*animation:\s*none/);
});
