import { SETTING_KEYS } from '@ai-engine/domain';
import { GitClient } from '@ai-engine/git';
import { checkRemoteAccess } from '@ai-engine/github';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import { detectRuntimeManifest, manifestGaps } from '@ai-engine/runtime-manifest';
import type { ProjectJobContext } from '../project-context';

/**
 * Everything a newly added project needs, and nothing written into it.
 *
 * Adding a project is one click, and what that click has to establish is not
 * instant: how the project builds means reading it, and the first knowledge
 * snapshot means walking the whole tree. So the project is created PENDING and
 * this moves it to READY.
 *
 * Nothing is written into the repository. It was gaining a marker, a manifest
 * file and a rules directory; all three now live in the database, where they
 * belong to this installation rather than to someone else's repository. A project
 * that is removed leaves no trace behind, and one that is added gains none.
 *
 * Safe to run twice: a setup that failed half way is retried by the queue, and
 * the second attempt must not produce a second manifest or a second snapshot.
 */
export async function handleProjectSetup(context: ProjectJobContext): Promise<void> {
  const project = context.project;
  await context.repos.projects.setSetupState(project.id, 'RUNNING');

  try {
    const git = new GitClient(project.repoPath);
    if (!(await git.isRepository())) {
      throw new Error(`${project.repoPath} is not a Git repository`);
    }
    if (!(await git.hasCommits())) {
      throw new Error(
        `${project.repoPath} has no commits yet. Every story starts from a base commit, so make the first one.`,
      );
    }

    // Read now rather than trusted from the request: the person picked a
    // directory, not a branch.
    const defaultBranch = await git.defaultBranch();
    const remoteUrl = await git.remoteUrl();
    if (defaultBranch !== project.defaultBranch || remoteUrl !== project.remoteUrl) {
      await context.repos.projects.update(project.id, { defaultBranch, remoteUrl });
    }

    // Whether a push is possible, established here rather than discovered by a
    // push that fails after everything else has succeeded.
    const token = await context.settings.text(SETTING_KEYS.githubToken);
    const access = await checkRemoteAccess(remoteUrl, token || undefined);
    await context.repos.projects.setRemoteAccess(project.id, access);

    // How the project builds and tests. In the database, not in a file in the
    // repository: it describes what this installation will run, and a project
    // that is removed should leave nothing behind.
    const existingManifest = await context.repos.runtimeManifests.latest(project.id);
    const manifest = existingManifest?.manifest ?? (await detectRuntimeManifest(project.repoPath));
    if (!existingManifest) await context.repos.runtimeManifests.create(project.id, manifest);

    const knowledge = new KnowledgeService(context.db);
    const existingSnapshot = await knowledge.latest(project.id);
    if (!existingSnapshot) {
      const head = await git.headCommit();
      const { snapshot, extraction } = await knowledge.buildSnapshot({
        projectId: project.id,
        gitCommit: head,
        repositoryPath: project.repoPath,
      });
      await context.events.append({
        projectId: project.id,
        eventType: 'KnowledgeSnapshotCreated',
        actorType: 'worker',
        actorId: context.workerId,
        payload: { snapshotId: snapshot.id, commit: head, entities: extraction.entities.length },
      });
    }

    await context.repos.projects.setSetupState(project.id, 'READY');
    await context.events.append({
      projectId: project.id,
      eventType: 'ProjectCreated',
      actorType: 'worker',
      actorId: context.workerId,
      payload: {
        repoPath: project.repoPath,
        defaultBranch,
        remoteAccess: access,
        gaps: manifestGaps(manifest),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Recorded on the project rather than only on the job, because the cockpit
    // shows projects and a person looking at a broken one should read why there
    // rather than go hunting through a queue.
    await context.repos.projects.setSetupState(context.project.id, 'FAILED', message);
    throw error;
  }
}
