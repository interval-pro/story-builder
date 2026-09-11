import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { GitClient } from '../src/git-client';

const run = promisify(execFile);

/**
 * A repository with a work branch and a story branch that disagree about one
 * line, which is the shape every merge conflict in this system actually has.
 */
async function divergent(): Promise<{ dir: string; git: GitClient }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'git-merge-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(path.join(dir, 'shared.txt'), 'original\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-qm', 'first'], { cwd: dir });

  await run('git', ['checkout', '-q', '-b', 'story'], { cwd: dir });
  await writeFile(path.join(dir, 'shared.txt'), 'the story wrote this\n');
  await run('git', ['commit', '-aqm', 'story change'], { cwd: dir });

  await run('git', ['checkout', '-q', 'main'], { cwd: dir });
  await writeFile(path.join(dir, 'shared.txt'), 'someone else wrote this\n');
  await run('git', ['commit', '-aqm', 'other change'], { cwd: dir });

  return { dir, git: new GitClient(dir) };
}

test('a clean repository reports no operation in progress', async () => {
  const { git } = await divergent();
  assert.equal(await git.operationInProgress(), null);
  assert.deepEqual(await git.unmergedPaths(), []);
});

test('a rebase that conflicts leaves the conflict in the tree rather than undoing it', async () => {
  const { git } = await divergent();
  await git.checkoutBranch('story');
  const rebase = await git.rebase('main');

  assert.equal(rebase.success, false);
  assert.deepEqual(rebase.conflicts, ['shared.txt']);
  // This is the whole point: the person can open their editor on it. Aborting
  // and reporting cleanly would throw away the one thing they need.
  assert.equal(await git.operationInProgress(), 'rebase');
  assert.deepEqual(await git.unmergedPaths(), ['shared.txt']);
});

test('resolving and continuing finishes the rebase', async () => {
  const { dir, git } = await divergent();
  await git.checkoutBranch('story');
  await git.rebase('main');

  await writeFile(path.join(dir, 'shared.txt'), 'both intentions, kept\n');
  await git.addAll();
  const carried = await git.continueRebase();

  assert.equal(carried.success, true);
  assert.equal(await git.operationInProgress(), null);
  // The story now sits on top of the work branch, which is what makes the merge
  // that follows a formality.
  assert.equal(await git.commitsAhead('main', 'story'), 1);
});

test('abandoning a rebase leaves the story branch exactly as it was', async () => {
  const { git } = await divergent();
  await git.checkoutBranch('story');
  const before = await git.headCommit();
  await git.rebase('main');
  await git.abortRebase();

  assert.equal(await git.operationInProgress(), null);
  assert.equal(await git.headCommit(), before);
});

test('a merge that conflicts is reported with the files it stopped on', async () => {
  const { git } = await divergent();
  const merge = await git.mergeBranch('story', 'Merge story: a title');

  assert.equal(merge.merged, false);
  assert.deepEqual(merge.conflicts, ['shared.txt']);
  assert.equal(await git.operationInProgress(), 'merge');
});

test('a merge after a rebase is the formality it is supposed to be', async () => {
  const { dir, git } = await divergent();
  await git.checkoutBranch('story');
  await git.rebase('main');
  await writeFile(path.join(dir, 'shared.txt'), 'both intentions, kept\n');
  await git.addAll();
  await git.continueRebase();

  await git.checkoutBranch('main');
  const undoCommit = await git.headCommit();
  const merge = await git.mergeBranch('story', 'Merge story: a title');

  assert.equal(merge.merged, true);
  assert.notEqual(await git.headCommit(), undoCommit);

  // And the recorded commit is enough to undo it with one action, which is the
  // reason it is recorded before anything moves.
  await git.resetHard(undoCommit);
  assert.equal(await git.headCommit(), undoCommit);
});

test('branches are listed newest first, which is the order a person thinks in', async () => {
  const { git } = await divergent();
  const branches = await git.listBranches();
  assert.deepEqual([...branches].sort(), ['main', 'story']);
  assert.equal(branches[0], 'main');
});

test('switching to a new branch actually moves the working directory onto it', async () => {
  const { git } = await divergent();
  const base = await git.headCommit();
  await git.switchToBranch('ai/story-something', base);

  // The failure this guards against is silent: `git branch` alone creates the
  // ref and leaves you on the branch you were already on, so a story's writes
  // land on the person's own branch while its branch stays empty.
  assert.equal(await git.currentBranch(), 'ai/story-something');
  assert.equal(await git.headCommit(), base);
});

test('switching to a branch that already exists just checks it out', async () => {
  const { git } = await divergent();
  const base = await git.headCommit();
  await git.switchToBranch('story', base);

  assert.equal(await git.currentBranch(), 'story');
  // And it is left where it was, not reset to the start point it was given.
  assert.notEqual(await git.headCommit(), base);
});

test('a merge is undoable while it is still the last thing that happened', async () => {
  const { dir, git } = await divergent();
  // A story of more than one commit, because counting commits is the obvious
  // wrong way to decide this and it fails exactly here.
  await git.checkoutBranch('story');
  await writeFile(path.join(dir, 'extra.txt'), 'more\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-qm', 'second story commit'], { cwd: dir });
  await git.rebase('main');
  await writeFile(path.join(dir, 'shared.txt'), 'both intentions, kept\n');
  await git.addAll();
  await git.continueRebase();

  await git.checkoutBranch('main');
  const undoCommit = await git.headCommit();
  await git.mergeBranch('story', 'Merge story: a title');

  // The first parent of a merge commit is where the branch stood before it,
  // which is the only check that survives a story of any length.
  assert.equal(await git.resolveRef('HEAD^1'), undoCommit);

  await writeFile(path.join(dir, 'later.txt'), 'someone else\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-qm', 'work after the merge'], { cwd: dir });

  // And once anything lands on top, it no longer does — which is what stops an
  // undo from taking someone else's commit with it.
  assert.notEqual(await git.resolveRef('HEAD^1'), undoCommit);
});
