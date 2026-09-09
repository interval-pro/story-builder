import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '@ai-engine/shared';
import { createRepositories, Database, migrate } from '@ai-engine/db';
import { GitClient } from '@ai-engine/git';
import { TaskCommands } from '@ai-engine/orchestrator';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import { detectRuntimeManifest, manifestGaps, toYaml } from '@ai-engine/runtime-manifest';
import { failure, heading, info, step, success, table, warn } from '../output';

const execFileAsync = promisify(execFile);

export const SYSTEM_VERSION = '0.1.0';

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs the system into a repository: validates Git, creates the vendored
 * .ai-engineering directory, migrates the database, inspects the project and
 * builds the first knowledge snapshot.
 */
export async function initCommand(options: { repoPath: string; skipDocker: boolean }): Promise<number> {
  const config = loadConfig();
  heading('AI Engineering System - init');

  const git = new GitClient(options.repoPath);
  step('Validating the Git repository');
  if (!(await git.isRepository())) {
    failure(`${options.repoPath} is not a Git repository.`);
    return 1;
  }
  const root = await git.repositoryRoot();
  if (!(await git.hasCommits())) {
    failure(`${root} has no commits yet.`);
    failure('Every task starts from a base commit, so make the first commit and run init again.');
    return 1;
  }
  const defaultBranch = await git.defaultBranch();
  const head = await git.headCommit();
  const remoteUrl = await git.remoteUrl();
  success(`Repository ${root} on ${defaultBranch} at ${head.slice(0, 10)}`);

  step('Checking Docker');
  const docker = await dockerAvailable();
  if (!docker && !options.skipDocker) {
    warn('Docker is not available. Task sandboxes will run on the host inside Git worktrees.');
    warn('Set SANDBOX_DOCKER_ENABLED=false to make that explicit.');
  } else if (docker) {
    success('Docker is available');
  }

  step('Installing .ai-engineering');
  const installRoot = path.join(root, '.ai-engineering');
  for (const directory of ['bootstrap', 'config', 'agents', 'policies', 'runtime', 'migrations', 'project-rules']) {
    await mkdir(path.join(installRoot, directory), { recursive: true });
  }
  await writeFile(path.join(installRoot, 'version'), `${SYSTEM_VERSION}\n`, 'utf8');
  success(`Installed version ${SYSTEM_VERSION}`);

  step('Migrating the system database');
  const db = new Database();
  try {
    const applied = await migrate(db);
    success(applied.length === 0 ? 'Database already up to date' : `Applied ${applied.length} migration(s)`);

    step('Registering the project');
    const commands = new TaskCommands(db);
    const project = await commands.ensureProject({ name: path.basename(root), repoPath: root });
    success(project.created ? 'Project registered' : 'Project already registered');

    step('Inspecting the project runtime');
    const manifest = await detectRuntimeManifest(root);
    const repositories = createRepositories(db);
    await repositories.runtimeManifests.create(project.id, manifest);
    await writeFile(path.join(installRoot, 'runtime-manifest.yaml'), toYaml(manifest), 'utf8');
    success(`Runtime manifest generated (${manifest.project.language.join(', ') || 'no language detected'})`);
    for (const gap of manifestGaps(manifest)) warn(gap);

    step('Building the initial project knowledge');
    const knowledge = new KnowledgeService(db);
    const { snapshot, extraction } = await knowledge.buildSnapshot({
      projectId: project.id,
      gitCommit: head,
      repositoryPath: root,
    });
    success(`Knowledge snapshot ${snapshot.sequence} built from ${extraction.entities.length} entities`);

    heading('Ready');
    table([
      ['Repository', root],
      ['Default branch', defaultBranch],
      ['Remote', remoteUrl ?? 'none (pull requests are disabled)'],
      ['AI provider', `${config.ai.provider} (${config.ai.model})`],
      ['Sandboxing', config.sandbox.enabled ? `docker (${config.sandbox.image})` : 'host worktrees'],
      ['API', config.service.apiBaseUrl],
      ['Web UI', 'http://localhost:3000'],
    ]);
    info('\nStart the stack with: docker compose up -d');
    info('Then open http://localhost:3000 and write your first story.\n');
    return 0;
  } finally {
    await db.close();
  }
}

export async function readInstalledVersion(repoPath: string): Promise<string | null> {
  try {
    return (await readFile(path.join(repoPath, '.ai-engineering', 'version'), 'utf8')).trim();
  } catch {
    return null;
  }
}
