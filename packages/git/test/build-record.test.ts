import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { GitClient } from '../src/git-client';
import { readBuildRecord, readBuildStatus, writeBuildRecord } from '../src/build-record';

const run = promisify(execFile);

async function checkout(): Promise<{ dir: string; buildFile: string; git: GitClient }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'build-record-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(path.join(dir, 'code.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-qm', 'first'], { cwd: dir });
  return { dir, buildFile: path.join(dir, '.state', 'build.json'), git: new GitClient(dir) };
}

test('a checkout with no record is treated as unbuilt rather than as up to date', async () => {
  const { dir, buildFile } = await checkout();
  const status = await readBuildStatus({ installRoot: dir, buildFile });

  assert.equal(status.builtCommit, null);
  // The safe reading of "nothing is known" is that nothing is running, not that
  // everything is fine.
  assert.equal(status.hasUnbuiltChanges, true);
});

test('a record matching HEAD means what is checked out is what is running', async () => {
  const { dir, buildFile, git } = await checkout();
  await writeBuildRecord(buildFile, {
    commit: await git.headCommit(),
    tag: null,
    builtAt: new Date().toISOString(),
    source: 'LOCAL',
  });

  const status = await readBuildStatus({ installRoot: dir, buildFile });
  assert.equal(status.hasUnbuiltChanges, false);
  assert.equal(status.commitsAhead, 0);
});

test('a commit made after the build is counted, because it is not running yet', async () => {
  const { dir, buildFile, git } = await checkout();
  const built = await git.headCommit();
  await writeBuildRecord(buildFile, { commit: built, tag: null, builtAt: new Date().toISOString(), source: 'LOCAL' });

  await writeFile(path.join(dir, 'code.txt'), 'two\n');
  await run('git', ['commit', '-aqm', 'second'], { cwd: dir });

  const status = await readBuildStatus({ installRoot: dir, buildFile });
  assert.equal(status.hasUnbuiltChanges, true);
  assert.equal(status.commitsAhead, 1);
  assert.equal(status.builtCommit, built);
});

test('uncommitted work counts as unbuilt too, since no build would pick it up', async () => {
  const { dir, buildFile, git } = await checkout();
  await writeBuildRecord(buildFile, {
    commit: await git.headCommit(),
    tag: null,
    builtAt: new Date().toISOString(),
    source: 'LOCAL',
  });
  await writeFile(path.join(dir, 'code.txt'), 'edited but not committed\n');

  const status = await readBuildStatus({ installRoot: dir, buildFile });
  assert.equal(status.dirty, true);
  assert.equal(status.hasUnbuiltChanges, true);
});

test('a newer release is a separate fact from local changes not running', async () => {
  const { dir, buildFile, git } = await checkout();
  await run('git', ['tag', 'v1.0.0'], { cwd: dir });
  await writeBuildRecord(buildFile, {
    commit: await git.headCommit(),
    tag: 'v1.0.0',
    builtAt: new Date().toISOString(),
    source: 'UPSTREAM',
  });

  const status = await readBuildStatus({ installRoot: dir, buildFile, latestRelease: 'v1.1.0' });
  // Nothing local to build, and still something newer upstream. One badge for
  // both would say nothing useful about either.
  assert.equal(status.hasUnbuiltChanges, false);
  assert.equal(status.releaseIsNewer, true);
});

test('an unreadable record reads as no record at all', async () => {
  const { buildFile } = await checkout();
  await writeFile(buildFile, 'not json', 'utf8').catch(async () => {
    await writeBuildRecord(buildFile, { commit: 'x', tag: null, builtAt: '', source: 'LOCAL' });
    await writeFile(buildFile, 'not json', 'utf8');
  });
  assert.equal(await readBuildRecord(buildFile), null);
});
