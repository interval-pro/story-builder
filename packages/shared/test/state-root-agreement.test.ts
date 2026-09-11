import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { stateRootFor } from '../src/paths.ts';

const helper = path.resolve(fileURLToPath(new URL('../../../scripts/state-root.sh', import.meta.url)));

function fromShell(installRoot: string, home: string): string {
  return execFileSync('bash', ['-c', `HOME=${JSON.stringify(home)}; . ${JSON.stringify(helper)}; state_root_for ${JSON.stringify(installRoot)}`], {
    encoding: 'utf8',
  }).trim();
}

/**
 * The start scripts resolve the state directory before any TypeScript runs, and
 * the services resolve it again themselves. If the two ever disagree the symptom
 * is not an error: the cockpit simply reads a build.json nothing writes, and
 * reports that the running version is unknown forever.
 */
test('the shell helper and the TypeScript resolve the same state directory', () => {
  const cases = [
    ['/Users/someone/work/story-builder', '/Users/someone'],
    ['/opt/story-builder-two', '/home/me'],
    ['/opt/Story_Builder2', '/home/me'],
    ['/srv/apps/sb', '/home/me'],
  ] as const;

  for (const [installRoot, home] of cases) {
    assert.equal(fromShell(installRoot, home), stateRootFor(installRoot, home), installRoot);
  }
});
