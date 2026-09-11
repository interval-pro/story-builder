import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { stateRootFor, workspacesRootProblem } from '../src/paths';

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

test('a worktree root inside the CLI configuration directory is refused by name', () => {
  const problem = workspacesRootProblem('/Users/someone/.claude/jobs/x/state/workspaces', '/Users/someone');
  assert.ok(problem, 'it must be refused');
  assert.match(problem!, /Claude CLI's own configuration directory/);
  assert.match(problem!, /implemented nothing/);
});

test('the ordinary place worktrees go is accepted', () => {
  assert.equal(workspacesRootProblem('/Users/someone/.story-builder/engine.state/workspaces', '/Users/someone'), null);
  assert.equal(workspacesRootProblem('/var/lib/story-builder/workspaces', '/Users/someone'), null);
});

test('a directory that merely starts with the same letters is not the same directory', () => {
  assert.equal(workspacesRootProblem('/Users/someone/.claude-workspaces', '/Users/someone'), null);
});

test('credentials and configuration directories are refused too', () => {
  assert.ok(workspacesRootProblem('/Users/someone/.ssh/workspaces', '/Users/someone'));
  assert.ok(workspacesRootProblem('/Users/someone/.config/story/workspaces', '/Users/someone'));
});
