import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findInstallation, readInstallationMarker, writeInstallationMarker } from '../src/installation';

async function project(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'install-'));
}

test('a project with no marker reports none', async () => {
  assert.equal(await readInstallationMarker(await project()), null);
});

test('a marker survives a write and a read', async () => {
  const root = await project();
  await writeInstallationMarker(root, {
    installRoot: '/somewhere/.story-builder/cars',
    name: 'cars',
    version: 'v0.1.0',
    installedAt: '2026-09-10T00:00:00.000Z',
  });
  const marker = await readInstallationMarker(root);
  assert.equal(marker?.installRoot, '/somewhere/.story-builder/cars');
  assert.equal(marker?.version, 'v0.1.0');
});

test('the marker is found from a nested directory', async () => {
  const root = await project();
  await writeInstallationMarker(root, {
    installRoot: '/somewhere/.story-builder/cars',
    name: 'cars',
    version: null,
    installedAt: '2026-09-10T00:00:00.000Z',
  });
  const nested = path.join(root, 'src', 'deep');
  await mkdir(nested, { recursive: true });
  const found = await findInstallation(nested);
  assert.equal(found?.projectRoot, root);
  assert.equal(found?.marker.name, 'cars');
});
