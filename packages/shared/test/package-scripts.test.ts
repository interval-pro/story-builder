import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

/**
 * A script that names a file which is not there fails only when something
 * finally runs it. "migrate" pointed at a helper that had been renamed, and it
 * surfaced the first time an installation tried to update itself, mid-way
 * through stopping every service. Build output is excluded because it exists
 * only after a build.
 */
test('every helper an npm script names is present', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  const missing: string[] = [];
  for (const [name, command] of Object.entries(manifest.scripts)) {
    for (const token of command.split(/\s+/)) {
      const candidate = token.replace(/^\.\//, '');
      if (!candidate.startsWith('scripts/')) continue;
      try {
        await access(path.join(root, candidate));
      } catch {
        missing.push(`${name}: ${token}`);
      }
    }
  }

  assert.deepEqual(missing, [], `npm scripts naming files that do not exist: ${missing.join(', ')}`);
});
