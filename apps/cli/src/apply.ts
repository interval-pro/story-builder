/**
 * Rebuilds this installation onto a candidate and restarts it.
 *
 * The order is the whole design. A build is where almost every failure happens
 * and it is also the one step that costs nothing to fail, because the running
 * processes hold the old code in memory and do not care what is on disk. So the
 * build happens first, while the old version is still serving. Only once it has
 * succeeded is anything stopped, and only then can a failure cost a restart.
 *
 * Every service is stopped part-way through, including the API that started
 * this, so this process is spawned detached and reports progress into Postgres,
 * which is the only thing up throughout.
 */
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig, statePaths } from '@ai-engine/shared';
import { readBuildRecord } from '@ai-engine/git';
import { createRepositories, Database } from '@ai-engine/db';

const execFileAsync = promisify(execFile);

interface StepResult {
  ok: boolean;
  output: string;
}

async function run(command: string, args: string[], cwd: string): Promise<StepResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() || String(error) };
  }
}

/** Runs a shell pipeline, which is how a dump reaches a file and comes back. */
async function shell(command: string, cwd: string): Promise<StepResult> {
  return run('/bin/sh', ['-c', command], cwd);
}

async function main(): Promise<number> {
  const applyId = process.argv[2];
  if (!applyId) {
    process.stderr.write('Usage: apply <applyId>\n');
    return 1;
  }

  const config = loadConfig();
  const installRoot = config.paths.installRoot;
  const state = statePaths(config.paths.stateRoot);
  const container = process.env['PG_CONTAINER'] ?? 'ai-engine-postgres';
  const db = new Database();
  const repos = createRepositories(db);

  const record = await repos.installationApplies.findById(applyId);
  if (!record || record.status !== 'RUNNING') {
    process.stderr.write(`No pending apply ${applyId}\n`);
    await db.close();
    return 1;
  }

  const log = async (step: string, output = ''): Promise<void> => {
    await repos.installationApplies.progress(applyId, step, output ? `[${step}] ${output}` : `[${step}]`);
  };

  // What was running when this started, which is the only commit known to
  // build and to serve. Everything else is a guess, including the commit before
  // the merge: it may never have been built.
  const known = (await readBuildRecord(state.buildFile))?.commit ?? record.builtCommit ?? record.previousCommit;

  const build = async (source: 'LOCAL' | 'UPSTREAM'): Promise<StepResult> =>
    run(path.join(installRoot, 'scripts', 'build.sh'), ['--source', source], installRoot);
  const start = async (): Promise<StepResult> =>
    run(path.join(installRoot, 'scripts', 'dev-up.sh'), [], installRoot);
  const stop = async (): Promise<StepResult> =>
    run(path.join(installRoot, 'scripts', 'dev-down.sh'), [], installRoot);

  /**
   * One rollback, to one target, because there is exactly one commit known to
   * work: the one that was running. No ladder backwards through history — a
   * commit that was never built is not a safer place to land than the one that
   * just failed.
   */
  const rollback = async (reason: string, stopped: boolean, snapshot: string | null): Promise<void> => {
    await log('rolling back', reason);
    await run('git', ['merge', '--abort'], installRoot);
    await run('git', ['reset', '--hard', known], installRoot);

    if (snapshot) {
      // The migration had already run, so the schema is ahead of the code being
      // restored. The dump was taken immediately before it for exactly this.
      await log('restoring the database', snapshot);
      const restored = await shell(
        `docker exec -i ${container} psql -U ai_engine -d postgres -c ` +
          `"DROP DATABASE IF EXISTS ai_engine WITH (FORCE)" -c "CREATE DATABASE ai_engine OWNER ai_engine" ` +
          `&& docker exec -i ${container} psql -q -U ai_engine -d ai_engine < ${JSON.stringify(snapshot)}`,
        installRoot,
      );
      if (!restored.ok) await log('the database could not be restored', restored.output.slice(-2000));
    }

    const rebuilt = await build('LOCAL');
    if (!rebuilt.ok) {
      await repos.installationApplies.finish(
        applyId,
        'FAILED',
        `[the rollback to ${known} did not build] ${rebuilt.output.slice(-4000)}\n`,
      );
      return;
    }
    if (stopped) await start();
    await repos.installationApplies.finish(applyId, 'ROLLED_BACK', `[rolled back to ${known}]\n`);
  };

  try {
    // ---------------------------------------------------------------------
    // Everything up to and including the build happens with the old version
    // still running and serving the cockpit.
    // ---------------------------------------------------------------------
    if (record.source === 'UPSTREAM') {
      await log('fetching the release', record.candidateRef);
      const fetched = await run('git', ['fetch', '--tags', 'origin'], installRoot);
      if (!fetched.ok) {
        await repos.installationApplies.finish(applyId, 'FAILED', `[fetch failed] ${fetched.output.slice(-4000)}\n`);
        return 1;
      }
    }

    // LOCAL means the commits are already here: the checkout is the candidate
    // and there is nothing to merge.
    if (record.source !== 'LOCAL') {
      // A fast forward keeps the installation exactly on the release, which is
      // what an untouched one should report. Only an installation carrying its
      // own commits needs a merge, and it is then honestly diverged.
      await log('merging the candidate', record.candidateRef);
      let merge = await run('git', ['merge', '--ff-only', record.candidateRef], installRoot);
      if (!merge.ok) {
        merge = await run(
          'git',
          ['merge', '--no-ff', '-m', `Apply ${record.candidateRef}`, record.candidateRef],
          installRoot,
        );
      }
      if (!merge.ok) {
        await run('git', ['merge', '--abort'], installRoot);
        await run('git', ['reset', '--hard', known], installRoot);
        await repos.installationApplies.finish(applyId, 'FAILED', `[merge failed] ${merge.output.slice(-4000)}\n`);
        return 1;
      }
    }

    await log('building', 'the running version keeps serving until this succeeds');
    const built = await build(record.source === 'UPSTREAM' ? 'UPSTREAM' : 'LOCAL');
    if (!built.ok) {
      // Nothing was stopped and nothing was migrated, so undoing the merge is
      // the entire cost of this failure.
      await run('git', ['reset', '--hard', known], installRoot);
      await repos.installationApplies.finish(applyId, 'FAILED', `[build failed] ${built.output.slice(-4000)}\n`);
      return 1;
    }

    // ---------------------------------------------------------------------
    // From here the running version is replaced, so every failure restores.
    // ---------------------------------------------------------------------
    await mkdir(state.snapshotsDir, { recursive: true });
    const snapshot = path.join(state.snapshotsDir, `${applyId}.sql`);
    await log('snapshotting the database', snapshot);
    const dumped = await shell(
      `docker exec -i ${container} pg_dump -U ai_engine -d ai_engine --clean --if-exists > ${JSON.stringify(snapshot)}`,
      installRoot,
    );
    // A migration without a snapshot is a one-way door, so this is a stop, not
    // a warning: the update can be tried again, a lost database cannot.
    if (!dumped.ok) {
      await run('git', ['reset', '--hard', known], installRoot);
      await build('LOCAL');
      await repos.installationApplies.finish(
        applyId,
        'FAILED',
        `[the database could not be snapshotted, so nothing was migrated] ${dumped.output.slice(-2000)}\n`,
      );
      return 1;
    }
    await repos.installationApplies.recordSnapshot(applyId, snapshot);

    await log('stopping the services');
    await stop();

    // The compiled migrator, not the npm script: the build has just run, and the
    // script exists for developing against sources rather than for a release
    // being applied.
    await log('migrating');
    const migrate = await run(process.execPath, ['packages/db/dist/cli/migrate.js'], installRoot);
    if (!migrate.ok) {
      await rollback(`migration failed: ${migrate.output.slice(-4000)}`, true, snapshot);
      return 1;
    }

    await log('running the tests');
    const tests = await run('npm', ['test'], installRoot);
    if (!tests.ok) {
      await rollback(`tests failed: ${tests.output.slice(-4000)}`, true, snapshot);
      return 1;
    }

    await log('starting the services');
    const started = await start();
    if (!started.ok) {
      await rollback(`the services did not come up: ${started.output.slice(-4000)}`, true, snapshot);
      return 1;
    }

    await repos.installationApplies.finish(applyId, 'SUCCEEDED', '[done]\n');
    return 0;
  } catch (error) {
    await rollback(error instanceof Error ? error.message : String(error), true, null);
    return 1;
  } finally {
    await db.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
