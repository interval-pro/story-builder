import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { GitClient } from '../src/git-client';

const run = promisify(execFile);

async function repository(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'git-status-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(path.join(dir, 'tracked.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-qm', 'first'], { cwd: dir });
  return dir;
}

test('a clean repository is clean', async () => {
  const git = new GitClient(await repository());
  assert.equal((await git.status()).clean, true);
});

test('a stray untracked file does not count as a change to the code', async () => {
  const dir = await repository();
  await writeFile(path.join(dir, 'Building'), '');
  const git = new GitClient(dir);
  assert.equal((await git.status()).clean, false);
  assert.equal((await git.status({ includeUntracked: false })).clean, true);
});

test('an edit to a tracked file counts either way', async () => {
  const dir = await repository();
  await writeFile(path.join(dir, 'tracked.txt'), 'two\n');
  const git = new GitClient(dir);
  assert.equal((await git.status()).clean, false);
  assert.equal((await git.status({ includeUntracked: false })).clean, false);
});
