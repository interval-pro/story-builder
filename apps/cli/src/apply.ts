/**
 * Applies a candidate to this installation.
 *
 * Every service is stopped while this runs, including the API that started it,
 * so this process is spawned detached and reports its progress into Postgres,
 * which is the only thing that stays up throughout.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '@ai-engine/shared';
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

async function main(): Promise<number> {
  const applyId = process.argv[2];
  if (!applyId) {
    process.stderr.write('Usage: apply <applyId>\n');
    return 1;
  }

  const config = loadConfig();
  const installRoot = config.paths.installRoot;
  const db = new Database();
  const repos = createRepositories(db);

  const record = await repos.installationApplies.latest(
    (await repos.projects.findInstallation())?.id ?? '',
  );
  if (!record || record.id !== applyId) {
    process.stderr.write(`No pending apply ${applyId}\n`);
    await db.close();
    return 1;
  }

  const log = async (step: string, output = ''): Promise<void> => {
    await repos.installationApplies.progress(applyId, step, output ? `[${step}] ${output}` : `[${step}]`);
  };

  const restart = async (): Promise<void> => {
    await run(path.join(installRoot, 'scripts', 'dev-up.sh'), [], installRoot);
  };

  const rollback = async (reason: string): Promise<void> => {
    await log('rolling back', reason);
    await run('git', ['merge', '--abort'], installRoot);
    await run('git', ['reset', '--hard', record.previousCommit], installRoot);
    await run('npm', ['ci'], installRoot);
    await run('npm', ['run', 'build'], installRoot);
    await restart();
    await repos.installationApplies.finish(applyId, 'ROLLED_BACK', `[rolled back to ${record.previousCommit}]\n`);
  };

  try {
    await log('stopping the services');
    await run(path.join(installRoot, 'scripts', 'dev-down.sh'), [], installRoot);

    await log('merging the candidate', record.candidateRef);
    const merge = await run('git', ['merge', '--no-ff', '-m', `Apply ${record.candidateRef}`, record.candidateRef], installRoot);
    if (!merge.ok) {
      await rollback(`merge failed: ${merge.output}`);
      return 1;
    }

    // Dependencies are only reinstalled when they actually changed, so an
    // apply does not need a network unless the candidate touched the lockfile.
    const changed = await run(
      'git',
      ['diff', '--name-only', record.previousCommit, 'HEAD', '--', 'package.json', 'package-lock.json'],
      installRoot,
    );
    if (changed.output.trim()) {
      await log('installing dependencies');
      const install = await run('npm', ['ci'], installRoot);
      if (!install.ok) {
        await rollback(`npm ci failed: ${install.output.slice(-4000)}`);
        return 1;
      }
    } else {
      await log('dependencies unchanged');
    }

    await log('building');
    const build = await run('npm', ['run', 'build'], installRoot);
    if (!build.ok) {
      await rollback(`build failed: ${build.output.slice(-4000)}`);
      return 1;
    }

    await log('migrating');
    const migrate = await run('npm', ['run', 'migrate'], installRoot);
    if (!migrate.ok) {
      await rollback(`migration failed: ${migrate.output.slice(-4000)}`);
      return 1;
    }

    await log('running the tests');
    const tests = await run('npm', ['test'], installRoot);
    if (!tests.ok) {
      await rollback(`tests failed: ${tests.output.slice(-4000)}`);
      return 1;
    }

    await log('starting the services');
    await restart();
    await repos.installationApplies.finish(applyId, 'SUCCEEDED', '[done]\n');
    return 0;
  } catch (error) {
    await rollback(error instanceof Error ? error.message : String(error));
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
