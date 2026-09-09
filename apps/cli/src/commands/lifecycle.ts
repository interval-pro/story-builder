import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '@ai-engine/shared';
import { createRepositories, Database } from '@ai-engine/db';
import { JobQueue } from '@ai-engine/queue';
import { failure, heading, info, step, success, table, warn } from '../output';
import { GitClient, readInstallationVersion } from '@ai-engine/git';
import { fetchLatestRelease } from '@ai-engine/github';
import { SYSTEM_VERSION } from './init';

const execFileAsync = promisify(execFile);

async function compose(args: string[], cwd: string): Promise<number> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', ['compose', ...args], { cwd });
    if (stdout.trim()) info(stdout.trim());
    if (stderr.trim()) info(stderr.trim());
    return 0;
  } catch (error) {
    const failureDetail = error as { stderr?: string; stdout?: string };
    failure(failureDetail.stderr ?? failureDetail.stdout ?? String(error));
    return 1;
  }
}

export async function startCommand(repoPath: string): Promise<number> {
  heading('Starting the AI engineering stack');
  step('docker compose up -d');
  return compose(['up', '-d'], repoPath);
}

export async function stopCommand(repoPath: string): Promise<number> {
  heading('Stopping the AI engineering stack');
  return compose(['down'], repoPath);
}

export async function statusCommand(repoPath: string): Promise<number> {
  const config = loadConfig();
  heading('AI Engineering System - status');

  const version = await describeInstallation();
  table([
    ['Installation', config.paths.installRoot],
    ['Version', version.tag ?? version.commit.slice(0, 10)],
    ['Latest release', version.latestRelease ?? 'unknown'],
    ['Version state', VERSION_LABELS[version.state] ?? version.state],
    ['CLI version', SYSTEM_VERSION],
    ['AI provider', `${config.ai.provider} (${config.ai.model})`],
    ['Sandboxing', config.sandbox.enabled ? 'docker' : 'host worktrees'],
  ]);

  const db = new Database();
  try {
    if (!(await db.healthy())) {
      failure('The database is not reachable. Is the stack running?');
      return 1;
    }
    const repos = createRepositories(db);
    const project = await repos.projects.findPrimary();
    if (!project) {
      warn('No project is registered yet. Run "ai-engine init".');
      return 1;
    }
    const active = await repos.tasks.listActive(project.id);
    const jobs = await new JobQueue(db).stats();

    heading('Project');
    table([
      ['Name', project.name],
      ['Repository', project.repoPath],
      ['Default branch', project.defaultBranch],
      ['Remote', project.remoteUrl ?? 'none'],
    ]);

    heading(`Active tasks (${active.length})`);
    if (active.length === 0) info('  none');
    for (const task of active) {
      info(`  ${task.id.slice(0, 8)}  ${task.state.padEnd(28)} ${task.branchName}`);
    }

    heading('Jobs');
    table(Object.entries(jobs).map(([status, count]) => [status, String(count)] as [string, string]));

    let apiHealthy = false;
    try {
      const response = await fetch(`${config.service.apiBaseUrl}/api/health`);
      apiHealthy = response.ok;
    } catch {
      apiHealthy = false;
    }
    heading('Services');
    table([
      ['API', apiHealthy ? 'up' : 'down'],
      ['Sandbox manager', (await sandboxHealthy()) ? 'up' : 'down'],
    ]);
    return 0;
  } finally {
    await db.close();
  }
}

async function sandboxHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${loadConfig().service.sandboxManagerUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Exports the portable state of this installation: the brain, the stories and
 * the reviews, without the artifacts that can be regenerated.
 */
export async function exportCommand(target: string): Promise<number> {
  const db = new Database();
  try {
    const repos = createRepositories(db);
    const project = await repos.projects.findPrimary();
    if (!project) {
      failure('No project is registered.');
      return 1;
    }
    const stories = await repos.stories.listByProject(project.id, 1000);
    const payload = {
      exportedAt: new Date().toISOString(),
      version: SYSTEM_VERSION,
      project,
      principles: await repos.principles.listAll(project.id),
      invariants: await repos.invariants.listAll(project.id),
      runtimeManifest: await repos.runtimeManifests.latest(project.id),
      stories: await Promise.all(
        stories.map(async (story) => ({
          story,
          revisions: await repos.stories.listRevisions(story.id),
          tasks: await repos.tasks.findByStory(story.id),
        })),
      ),
    };
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
    success(`Exported ${stories.length} stories to ${target}`);
    return 0;
  } finally {
    await db.close();
  }
}

export async function importCommand(source: string): Promise<number> {
  const db = new Database();
  try {
    const raw = await readFile(source, 'utf8');
    const payload = JSON.parse(raw) as {
      principles: { category: string; statement: string; scope: string }[];
      invariants: { statement: string; scope: string }[];
    };
    const repos = createRepositories(db);
    const project = await repos.projects.findPrimary();
    if (!project) {
      failure('Run "ai-engine init" before importing.');
      return 1;
    }
    for (const principle of payload.principles ?? []) {
      await repos.principles.create({
        projectId: project.id,
        category: principle.category,
        statement: principle.statement,
        scope: principle.scope,
      });
    }
    for (const invariant of payload.invariants ?? []) {
      await repos.invariants.create({ projectId: project.id, statement: invariant.statement, scope: invariant.scope });
    }
    success(`Imported ${payload.principles?.length ?? 0} principles and ${payload.invariants?.length ?? 0} invariants`);
    return 0;
  } finally {
    await db.close();
  }
}

/** Reads what this installation runs and how it compares to the newest release. */
export async function describeInstallation() {
  const config = loadConfig();
  const remote = await new GitClient(config.paths.installRoot).remoteUrl();
  const latest = remote ? await fetchLatestRelease(remote) : null;
  return readInstallationVersion(config.paths.installRoot, latest?.tag ?? null);
}

export const VERSION_LABELS: Record<string, string> = {
  up_to_date: 'up to date with the latest release',
  behind: 'behind the latest release',
  diverged: 'changed locally',
  unknown: 'unknown',
};

export async function versionCommand(): Promise<number> {
  const config = loadConfig();
  const version = await describeInstallation();
  heading('Story Builder - version');
  table([
    ['Installation', config.paths.installRoot],
    ['Project', config.paths.projectRoot],
    ['Release', version.tag ?? 'none'],
    ['Commit', version.commit.slice(0, 10)],
    ['Local commits', String(version.localCommits)],
    ['Uncommitted changes', version.dirty ? 'yes' : 'no'],
    ['Latest release', version.latestRelease ?? 'unknown'],
    ['State', VERSION_LABELS[version.state] ?? version.state],
  ]);
  if (version.state === 'behind') {
    info(`\nA newer release is available: ${version.latestRelease}.`);
  }
  if (version.state === 'diverged') {
    info('\nThis installation carries local changes, so it no longer matches any release.');
  }
  return 0;
}
