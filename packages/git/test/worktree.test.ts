import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { WorktreeManager } from '../src/worktree';

const run = promisify(execFile);

async function repository(): Promise<{ repo: string; workspaces: string; head: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'worktree-'));
  const repo = path.join(root, 'repo');
  const workspaces = path.join(root, 'workspaces');
  await run('git', ['init', '-q', '-b', 'main', repo]);
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await run('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await writeFile(path.join(repo, 'file.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-qm', 'first'], { cwd: repo });
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: repo });
  return { repo, workspaces, head: stdout.trim() };
}

test('re-entering a phase keeps work that has not been committed', async () => {
  const { repo, workspaces, head } = await repository();
  const manager = new WorktreeManager(repo, workspaces);
  const created = await manager.create({ taskId: 'a', branch: 'ai/a', baseCommit: head });
  await writeFile(path.join(created.path, 'in-progress.txt'), 'half done\n');

  const again = await manager.create({ taskId: 'a', branch: 'ai/a', baseCommit: head });

  assert.equal(again.path, created.path);
  assert.equal(await readFile(path.join(again.path, 'in-progress.txt'), 'utf8'), 'half done\n');
});

test('a worktree on the wrong branch is rebuilt', async () => {
  const { repo, workspaces, head } = await repository();
  const manager = new WorktreeManager(repo, workspaces);
  const created = await manager.create({ taskId: 'b', branch: 'ai/b', baseCommit: head });
  await writeFile(path.join(created.path, 'stale.txt'), 'from the wrong branch\n');

  const again = await manager.create({ taskId: 'b', branch: 'ai/other', baseCommit: head });

  await assert.rejects(() => access(path.join(again.path, 'stale.txt')));
});

test('a registration whose directory is gone is replaced', async () => {
  const { repo, workspaces, head } = await repository();
  const manager = new WorktreeManager(repo, workspaces);
  const created = await manager.create({ taskId: 'c', branch: 'ai/c', baseCommit: head });
  await run('rm', ['-rf', created.path]);

  const again = await manager.create({ taskId: 'c', branch: 'ai/c', baseCommit: head });

  await access(path.join(again.path, 'file.txt'));
});
