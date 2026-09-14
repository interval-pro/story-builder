import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/**
 * The failure this pins happened for real: an agent wrote code containing a
 * NUL character, recording that tool call in Postgres threw, and because the
 * stream handler's promise was discarded the rejection went unhandled and the
 * whole worker process exited in the middle of an implementation. Every job it
 * held stayed locked until its lease ran out.
 *
 * Run in a separate process, because the thing being tested is whether the
 * process survives, and a crash inside the test runner would be reported as
 * something else.
 */
test('a stream handler that throws does not take the process down with it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-handler-'));
  const fake = path.join(dir, 'claude');
  writeFileSync(
    fake,
    [
      '#!/bin/sh',
      'cat > /dev/null',
      `echo '{"type":"assistant","session_id":"s1","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file":"a.ts"}}]}}'`,
      'sleep 0.2',
      `echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s1"}'`,
    ].join('\n'),
  );
  chmodSync(fake, 0o755);

  const script = path.join(dir, 'run.mjs');
  writeFileSync(
    script,
    `
    import { runClaudeCli } from ${JSON.stringify(path.join(repoRoot, 'packages/claude-code/src/cli.ts'))};
    const result = await runClaudeCli({
      cwd: ${JSON.stringify(dir)},
      prompt: 'anything',
      timeoutMs: 10000,
      binary: ${JSON.stringify(fake)},
      onEvent: async () => { throw new Error('recording the tool call failed'); },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    console.log('finished: ' + result.text);
    `,
  );

  const run = spawnSync(process.execPath, ['--import', path.join(repoRoot, 'scripts/register-source.mjs'), script], {
    encoding: 'utf8',
    cwd: repoRoot,
    timeout: 30_000,
  });

  assert.equal(run.status, 0, `the process exited with ${run.status}:\n${run.stderr}`);
  assert.match(run.stdout, /finished: done/);
});
