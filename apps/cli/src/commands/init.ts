import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig, writeInstallationMarker } from '@ai-engine/shared';
import { createRepositories, Database, migrate } from '@ai-engine/db';
import { GitClient, readInstallationVersion } from '@ai-engine/git';
import { fetchLatestRelease } from '@ai-engine/github';
import { TaskCommands } from '@ai-engine/orchestrator';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import { detectRuntimeManifest, manifestGaps, toYaml } from '@ai-engine/runtime-manifest';
import { failure, heading, info, step, success, table, warn } from '../output';

const execFileAsync = promisify(execFile);

export const SYSTEM_VERSION = '0.1.0';

const PROJECT_RULES_README = `# Project rules

Rules placed here are read as part of the Project Brain and apply to every
agent working on this repository. They are version controlled with the project,
so changing them is a normal code review.

A rule is a sentence about how work is done here, not a description of what the
code currently does. The system already reads the code.
`;

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Registers the installation, and optionally a first project.
 *
 * A repository is optional because an installation serves as many projects as
 * are added to it from the cockpit. Installing with none is the normal first
 * step: the engine comes up, and the first project is one click away. Passing one
 * here is a convenience for an installation that already knows what it is for.
 */
export async function initCommand(options: {
  repoPath: string | null;
  installRoot: string;
  skipDocker: boolean;
}): Promise<number> {
  const config = loadConfig();
  heading('Story Builder - init');

  let root: string | null = null;
  let defaultBranch = '';
  let head = '';
  let remoteUrl: string | null = null;

  if (options.repoPath) {
    const git = new GitClient(options.repoPath);
    step('Validating the project repository');
    if (!(await git.isRepository())) {
      failure(`${options.repoPath} is not a Git repository.`);
      return 1;
    }
    root = await git.repositoryRoot();
    if (!(await git.hasCommits())) {
      failure(`${root} has no commits yet.`);
      failure('Every task starts from a base commit, so make the first commit and run init again.');
      return 1;
    }
    defaultBranch = await git.defaultBranch();
    head = await git.headCommit();
    remoteUrl = await git.remoteUrl();
    success(`Repository ${root} on ${defaultBranch} at ${head.slice(0, 10)}`);

    if (path.resolve(root) === path.resolve(options.installRoot)) {
      failure('The installation and the project are the same directory.');
      failure('Install the engine outside the repository it works on, for example under ~/.story-builder.');
      return 1;
    }
  } else {
    info('No repository was given, so the installation is registered on its own.');
    info('Add the projects you want worked on from the cockpit.');
  }

  step('Reading the installation');
  const installGit = new GitClient(options.installRoot);
  const installRemote = await installGit.remoteUrl();
  const latest = installRemote ? await fetchLatestRelease(installRemote) : null;
  const version = await readInstallationVersion(options.installRoot, latest?.tag ?? null);
  success(`Installation ${options.installRoot} at ${version.tag ?? version.commit.slice(0, 10)}`);

  step('Checking Docker');
  const docker = await dockerAvailable();
  if (!docker && !options.skipDocker) {
    warn('Docker is not available. Task sandboxes will run on the host inside Git worktrees.');
    warn('Set SANDBOX_DOCKER_ENABLED=false to make that explicit.');
  } else if (docker) {
    success('Docker is available');
  }

  step('Migrating the installation database');
  const db = new Database();
  try {
    const applied = await migrate(db);
    success(applied.length === 0 ? 'Database already up to date' : `Applied ${applied.length} migration(s)`);

    const commands = new TaskCommands(db);

    // The installation is a project too, so a story can change the engine that
    // serves these repositories without touching any of them.
    step('Registering the installation as a project');
    const installProject = await commands.ensureProject({
      name: `${path.basename(options.installRoot)} (installation)`,
      repoPath: path.resolve(options.installRoot),
      kind: 'INSTALLATION',
    });
    success(installProject.created ? 'Installation registered' : 'Installation already registered');

    const repositories = createRepositories(db);
    const knowledge = new KnowledgeService(db);

    if (root) {
      step('Registering the project');
      const project = await commands.ensureProject({ name: path.basename(root), repoPath: root });
      success(project.created ? 'Project registered' : 'Project already registered');

      step('Writing the installation marker');
      await writeInstallationMarker(root, {
        installRoot: path.resolve(options.installRoot),
        name: path.basename(options.installRoot),
        version: version.tag,
        installedAt: new Date().toISOString(),
      });
      success('The project now knows which installation serves it');

      step('Inspecting the project runtime');
      const manifest = await detectRuntimeManifest(root);
      await repositories.runtimeManifests.create(project.id, manifest);
      const projectConfigRoot = path.join(root, '.ai-engineering');
      await mkdir(path.join(projectConfigRoot, 'project-rules'), { recursive: true });
      await writeFile(path.join(projectConfigRoot, 'runtime-manifest.yaml'), toYaml(manifest), 'utf8');
      await writeFile(path.join(projectConfigRoot, 'project-rules', 'README.md'), PROJECT_RULES_README, 'utf8');
      success(`Runtime manifest generated (${manifest.project.language.join(', ') || 'no language detected'})`);
      for (const gap of manifestGaps(manifest)) warn(gap);

      step('Building the initial project knowledge');
      const { snapshot, extraction } = await knowledge.buildSnapshot({
        projectId: project.id,
        gitCommit: head,
        repositoryPath: root,
      });
      success(`Knowledge snapshot ${snapshot.sequence} built from ${extraction.entities.length} entities`);
    }

    step('Building the knowledge for the installation');
    const installManifest = await detectRuntimeManifest(options.installRoot);
    await repositories.runtimeManifests.create(installProject.id, installManifest);
    const installKnowledge = await knowledge.buildSnapshot({
      projectId: installProject.id,
      gitCommit: await installGit.headCommit(),
      repositoryPath: path.resolve(options.installRoot),
    });
    success(`Installation snapshot ${installKnowledge.snapshot.sequence} built`);

    heading('Ready');
    table([
      ['Project', root ?? 'none yet — add one from the cockpit'],
      ['Installation', options.installRoot],
      ['Installation branch', await installGit.currentBranch().catch(() => 'detached')],
      ['Version', version.tag ?? version.commit.slice(0, 10)],
      ['Latest release', latest?.tag ?? 'unknown'],
      ['Default branch', defaultBranch || '—'],
      ['Remote', remoteUrl ?? 'none (pull requests are disabled)'],
      ['AI provider', `${config.ai.provider} (${config.ai.model})`],
      ['Sandboxing', config.sandbox.enabled ? `docker (${config.sandbox.image})` : 'host worktrees'],
      ['Web UI', 'http://localhost:3000'],
    ]);
    info('\nStart the system with: ./scripts/dev-up.sh\n');
    return 0;
  } finally {
    await db.close();
  }
}
