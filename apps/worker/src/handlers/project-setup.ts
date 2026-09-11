import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeInstallationMarker } from '@ai-engine/shared';
import { GitClient, readInstallationVersion } from '@ai-engine/git';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import { detectRuntimeManifest, manifestGaps, toYaml } from '@ai-engine/runtime-manifest';
import type { ProjectJobContext } from '../project-context';

const PROJECT_RULES_README = `# Project rules

Rules placed here are read as part of the Project Brain and apply to every
agent working on this repository. They are version controlled with the project,
so changing them is a normal code review.

A rule is a sentence about how work is done here, not a description of what the
code currently does. The system already reads the code.
`;

/**
 * Everything a newly added project needs before a story can run against it.
 *
 * Adding a project from the cockpit is one click, and what that click has to set
 * up is not instant: detecting how the project builds means reading it, and the
 * first knowledge snapshot means walking the whole tree. Doing it in the request
 * would leave the browser waiting on a repository it has never seen the size of,
 * so the project is created PENDING and this moves it to READY.
 *
 * It is written to be safe to run twice. A setup that failed half way through is
 * retried by the queue, and the second attempt must not produce a second
 * manifest, a second snapshot and a second marker.
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
        `${project.repoPath} has no commits yet. Every task starts from a base commit, so make the first one.`,
      );
    }

    // The branch and remote are read now rather than trusted from the request:
    // the person picked a directory, not a branch.
    const defaultBranch = await git.defaultBranch();
    const remoteUrl = await git.remoteUrl();
    if (defaultBranch !== project.defaultBranch || remoteUrl !== project.remoteUrl) {
      await context.repos.projects.update(project.id, { defaultBranch, remoteUrl });
    }

    const head = await git.headCommit();

    // How the project builds and tests. Detected once here, then read by every
    // sandbox; a project with no manifest cannot run its own tests, which is the
    // difference between QA checking the change and QA taking the agent's word.
    const manifest = await detectRuntimeManifest(project.repoPath);
    const existingManifest = await context.repos.runtimeManifests.latest(project.id);
    if (!existingManifest) {
      await context.repos.runtimeManifests.create(project.id, manifest);
    }

    // The project gains two things and nothing else: a marker naming the
    // installation that serves it, and a place to put its own rules.
    const configRoot = path.join(project.repoPath, '.ai-engineering');
    await mkdir(path.join(configRoot, 'project-rules'), { recursive: true });
    await writeFile(path.join(configRoot, 'runtime-manifest.yaml'), toYaml(manifest), 'utf8');
    await writeFile(path.join(configRoot, 'project-rules', 'README.md'), PROJECT_RULES_README, 'utf8');

    const installGit = new GitClient(context.installRoot);
    const version = await readInstallationVersion(context.installRoot, null).catch(() => null);
    await writeInstallationMarker(project.repoPath, {
      installRoot: context.installRoot,
      name: path.basename(context.installRoot),
      version: version?.tag ?? null,
      installedAt: new Date().toISOString(),
    });
    await installGit.isRepository().catch(() => false);

    const knowledge = new KnowledgeService(context.db);
    const existingSnapshot = await knowledge.latest(project.id);
    if (!existingSnapshot) {
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
        hasRemote: Boolean(remoteUrl),
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
