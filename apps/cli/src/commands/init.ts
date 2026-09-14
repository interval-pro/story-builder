import path from 'node:path';
import { loadConfig } from '@ai-engine/shared';
import { createRepositories, Database, migrate } from '@ai-engine/db';
import { GitClient, readInstallationVersion } from '@ai-engine/git';
import { fetchLatestRelease } from '@ai-engine/github';
import { TaskCommands } from '@ai-engine/orchestrator';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import { detectRuntimeManifest } from '@ai-engine/runtime-manifest';
import { heading, info, step, success, table } from '../output';

export const SYSTEM_VERSION = '0.1.0';

/**
 * Registers the installation itself as a project.
 *
 * Run by dev-up.sh the first time it finds a database that does not know about
 * the installation. Projects to work on are added from the cockpit, which is
 * the one path that prepares them properly: it checks the repository, records
 * the branch and whether the token can push, and reads it once in the
 * background. An older `--repo` option here registered a project around all of
 * that and was removed.
 */
export async function initCommand(options: { installRoot: string }): Promise<number> {
  const config = loadConfig();
  heading('Story Builder - init');

  step('Reading the installation');
  const installGit = new GitClient(options.installRoot);
  const installRemote = await installGit.remoteUrl();
  const latest = installRemote ? await fetchLatestRelease(installRemote) : null;
  const version = await readInstallationVersion(options.installRoot, latest?.tag ?? null);
  success(`Installation ${options.installRoot} at ${version.tag ?? version.commit.slice(0, 10)}`);

  step('Migrating the installation database');
  const db = new Database();
  try {
    const applied = await migrate(db);
    success(applied.length === 0 ? 'Database already up to date' : `Applied ${applied.length} migration(s)`);

    // The installation is a project too, so a story can change the engine that
    // serves these repositories without touching any of them.
    step('Registering the installation as a project');
    const installProject = await new TaskCommands(db).ensureProject({
      name: `${path.basename(options.installRoot)} (installation)`,
      repoPath: path.resolve(options.installRoot),
      kind: 'INSTALLATION',
    });
    success(installProject.created ? 'Installation registered' : 'Installation already registered');

    step('Building the knowledge for the installation');
    const installManifest = await detectRuntimeManifest(options.installRoot);
    await createRepositories(db).runtimeManifests.create(installProject.id, installManifest);
    const installKnowledge = await new KnowledgeService(db).buildSnapshot({
      projectId: installProject.id,
      gitCommit: await installGit.headCommit(),
      repositoryPath: path.resolve(options.installRoot),
    });
    success(`Installation snapshot ${installKnowledge.snapshot.sequence} built`);

    heading('Ready');
    table([
      ['Installation', options.installRoot],
      ['Installation branch', await installGit.currentBranch().catch(() => 'detached')],
      ['Version', version.tag ?? version.commit.slice(0, 10)],
      ['Latest release', latest?.tag ?? 'unknown'],
      ['AI provider', `${config.ai.provider} (${config.ai.model})`],
      ['Where stories run', 'in the project directory, one branch per story'],
    ]);
    info('\nAdd the projects you want worked on from the cockpit.\n');
    return 0;
  } finally {
    await db.close();
  }
}
