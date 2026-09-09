import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitClient } from '../src/git-client.ts';

async function repository(): Promise<GitClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-engine-git-'));
  const git = new GitClient(directory);
  await git.run(['init', '-q', '-b', 'main']);
  await git.configure('user.email', 'test@example.com');
  await git.configure('user.name', 'Test');
  await writeFile(path.join(directory, 'a.txt'), 'hello\n', 'utf8');
  await git.addAll();
  await git.commit('initial');
  return git;
}

test('a fresh repository reports that it has commits', async () => {
  const git = await repository();
  assert.equal(await git.hasCommits(), true);
  assert.equal(await git.currentBranch(), 'main');
});

test('an empty repository does not pretend to have a commit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-engine-git-empty-'));
  const git = new GitClient(directory);
  await git.run(['init', '-q', '-b', 'main']);
  assert.equal(await git.hasCommits(), false);
  assert.equal(await git.currentBranch(), 'main');
  await assert.rejects(git.headCommit(), /no commits yet/);
});

/**
 * A headless worker has no terminal and usually no credential helper, so a push
 * to an unreachable remote must fail with output rather than hang on a prompt.
 */
test('pushing without credentials fails instead of prompting', async () => {
  const git = await repository();
  await git.run(['remote', 'add', 'origin', 'https://127.0.0.1:1/nope/nope.git']);
  const result = await git.push('origin', 'main', { token: 'not-a-real-token' });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stderr.includes('could not read Username'), false);
});

test('the token never reaches the repository configuration', async () => {
  const git = await repository();
  await git.run(['remote', 'add', 'origin', 'https://127.0.0.1:1/nope/nope.git']);
  await git.push('origin', 'main', { token: 'super-secret-token' });

  const config = await git.run(['config', '--local', '--list'], { allowFailure: true });
  assert.equal(config.stdout.includes('super-secret-token'), false);

  const remote = await git.remoteUrl('origin');
  assert.equal(remote?.includes('super-secret-token'), false);
});
