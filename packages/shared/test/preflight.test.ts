import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scripts = path.resolve(fileURLToPath(new URL('../../../scripts/', import.meta.url)));
const preflight = path.join(scripts, 'preflight.sh');

/**
 * Runs a snippet with the preflight helpers loaded, optionally with fake
 * programs first on the PATH. A fake is how "Docker is not running" and "Node
 * is too old" are tested without stopping Docker or installing an old Node.
 */
function run(snippet: string, fakes: Record<string, string> = {}, keepPath = true) {
  const bin = mkdtempSync(path.join(tmpdir(), 'preflight-bin-'));
  for (const [name, body] of Object.entries(fakes)) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  const basePath = keepPath ? `${bin}:${process.env['PATH']}` : `${bin}:/usr/bin:/bin`;
  const result = spawnSync('/bin/bash', ['-c', `. ${JSON.stringify(preflight)}; ${snippet}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: basePath },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('a missing program is named, with what to do about it', () => {
  const result = run('need_command docker "Install Docker Desktop."', {}, false);
  assert.equal(result.code, 1);
  assert.match(result.err, /docker is not installed/);
  assert.match(result.err, /Install Docker Desktop\./);
});

test('Docker that is installed but not running says so, not that it is missing', () => {
  const result = run('need_docker', {
    docker: 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1',
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /installed but not running/);
  assert.match(result.err, /Start Docker Desktop/);
  // The evidence is carried through, so the person sees Docker's own words.
  assert.match(result.err, /Cannot connect to the Docker daemon/);
});

test('Docker that refuses this user is told apart from Docker that is down', () => {
  const result = run('need_docker', {
    docker: 'echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1',
  });
  assert.equal(result.code, 1);
  assert.match(result.err, /may not talk to it/);
});

test('a Node older than required names both versions', () => {
  const result = run('need_node 20', { node: 'echo v18.19.0', npm: 'echo 10.0.0' });
  assert.equal(result.code, 1);
  assert.match(result.err, /v18\.19\.0 is too old/);
  assert.match(result.err, /20 or newer/);
});

test('a new enough Node passes quietly', () => {
  const result = run('need_node 20 && echo fine', { node: 'echo v22.1.0', npm: 'echo 10.0.0' });
  assert.equal(result.code, 0);
  assert.equal(result.out.trim(), 'fine');
  assert.equal(result.err, '');
});

test('an env file with a stray line is refused before it is executed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'preflight-env-'));
  const file = path.join(dir, 'env');
  writeFileSync(file, 'PG_PORT=5433\n# a comment\n\nrm -rf something\nAPI_PORT=4000\n');
  const result = run(`check_env_file ${JSON.stringify(file)}`);
  assert.equal(result.code, 1);
  assert.match(result.err, /lines that are not settings/);
  // The line number, so it can be found.
  assert.match(result.err, /4:rm -rf something/);
});

test('a clean env file passes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'preflight-env-'));
  const file = path.join(dir, 'env');
  writeFileSync(file, '# comment\nPG_PORT=5433\nDATABASE_URL=postgres://a:b@localhost:5433/db\n');
  assert.equal(run(`check_env_file ${JSON.stringify(file)}`).code, 0);
});

test('the port is read out of a database URL, with or without credentials', () => {
  assert.equal(run('url_port postgres://ai_engine:ai_engine@localhost:5433/ai_engine').out, '5433');
  assert.equal(run('url_port postgres://localhost:5432/db').out, '5432');
  assert.equal(run('url_port postgresql://u@db.internal:6543/x').out, '6543');
});

test('a port someone is listening on is reported with the process that holds it', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const result = run(`port_holder ${port}`);
    assert.match(result.out, new RegExp(`^${process.pid} `));
  } finally {
    server.close();
  }
});

test('a free port has no holder', () => {
  assert.equal(run('port_holder 1').out, '');
});

test('waiting gives up after the time it was given rather than hanging', () => {
  const started = Date.now();
  const result = run('wait_until 1 false; echo "gave up $?"');
  assert.match(result.out, /gave up 1/);
  assert.ok(Date.now() - started < 5_000);
});

test('the process that runs these tests is not mistaken for part of another directory', () => {
  const result = run(`owned_by_checkout ${process.pid} /definitely/not/here && echo ours || echo not-ours`);
  assert.equal(result.out.trim(), 'not-ours');
});

test('a failure nothing anticipated still says where the script stopped', () => {
  // The net under every other check: a script that prints one step and then
  // exits 1 with nothing after it is the worst message there is.
  const result = run('guard_unexpected; set -e; echo before; false; echo after');
  assert.equal(result.code, 1);
  assert.equal(result.out.trim(), 'before');
  assert.match(result.err, /stopped unexpectedly at line/);
  assert.match(result.err, /│ false/);
});

test('a failure inside a condition is a decision, not an unexpected stop', () => {
  const result = run('guard_unexpected; set -e; if false; then :; fi; false || true; echo reached');
  assert.equal(result.code, 0);
  assert.equal(result.out.trim(), 'reached');
  assert.equal(result.err, '');
});
