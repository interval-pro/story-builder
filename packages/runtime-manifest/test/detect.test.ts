import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectRuntimeManifest, emptyManifest } from '../src/detect.ts';
import { manifestGaps, validateRuntimeManifest } from '../src/validate.ts';
import { toYaml } from '../src/serialize.ts';

async function fixture(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-engine-manifest-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(directory, name), content, 'utf8');
  }
  return directory;
}

test('a Node project with a lock file is detected', async () => {
  const directory = await fixture({
    'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'node --test', lint: 'eslint .' } }),
    'package-lock.json': '{}',
    'tsconfig.json': '{}',
  });
  const manifest = await detectRuntimeManifest(directory);
  assert.deepEqual(manifest.project.language, ['typescript']);
  assert.equal(manifest.project.packageManager, 'npm');
  assert.deepEqual(manifest.setup.commands, ['npm ci']);
  assert.deepEqual(manifest.test.commands, ['npm test']);
  assert.deepEqual(manifest.build.commands, ['npm run build']);
});

test('a Python project is detected without a Node package', async () => {
  const directory = await fixture({ 'requirements.txt': 'pytest\n' });
  const manifest = await detectRuntimeManifest(directory);
  assert.deepEqual(manifest.project.language, ['python']);
  assert.ok(manifest.test.commands.includes('pytest'));
});

test('a project with nothing recognisable reports its gaps', async () => {
  const directory = await fixture({ 'README.md': 'hello' });
  const manifest = await detectRuntimeManifest(directory);
  const gaps = manifestGaps(manifest);
  assert.ok(gaps.some((gap) => gap.includes('No language')));
  assert.ok(gaps.some((gap) => gap.includes('No test command')));
});

test('validation stops at the first failing command', async () => {
  const manifest = emptyManifest();
  manifest.setup.commands = ['setup'];
  manifest.build.commands = ['build'];

  const attempted: string[] = [];
  const result = await validateRuntimeManifest(
    manifest,
    {
      run: async ({ command }) => {
        attempted.push(command);
        return { exitCode: command === 'setup' ? 0 : 1, stdout: '', stderr: 'boom' };
      },
    },
    { runTests: false },
  );

  assert.equal(result.valid, false);
  assert.deepEqual(attempted, ['setup', 'build']);
});

test('the manifest serialises to readable YAML', async () => {
  const directory = await fixture({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
  });
  const yaml = toYaml(await detectRuntimeManifest(directory));
  assert.ok(yaml.includes('project:'));
  assert.ok(yaml.includes('test:'));
  assert.ok(yaml.includes('"npm test"'));
});
