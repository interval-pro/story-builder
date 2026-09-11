import { rm } from 'node:fs/promises';
import path from 'node:path';
import { HttpRouter, loadConfig, ValidationError } from '@ai-engine/shared';
import { GitClient } from '@ai-engine/git';
import { requireBody, type ApiContext } from '../context';

/**
 * Projects are added and removed here rather than by the installer.
 *
 * An installation used to serve exactly one repository, fixed at install time,
 * and the API silently worked against the first project it found. Adding a second
 * one would have sent its work to the first. Now the installer installs an engine
 * and the projects are a thing you manage while it runs.
 */
export function registerProjectRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/projects', async () => {
    const projects = await context.repos.projects.list();
    const detailed = await Promise.all(
      projects.map(async (project) => {
        const counts = await context.repos.tasks.countsByState(project.id);
        const snapshot = await context.knowledge.latest(project.id).catch(() => null);
        const manifest = await context.repos.runtimeManifests.latest(project.id).catch(() => null);
        return {
          ...project,
          taskCounts: counts,
          knowledgeSnapshot: snapshot ? { sequence: snapshot.sequence, gitCommit: snapshot.gitCommit } : null,
          runtimeManifest: manifest ? { version: manifest.version, validated: manifest.validated } : null,
        };
      }),
    );
    return { projects: detailed };
  });

  router.get('/api/projects/:id', async ({ params }) => {
    const project = await context.repos.projects.getById(params['id']!);
    const git = new GitClient(project.repoPath);
    return {
      project,
      taskCounts: await context.repos.tasks.countsByState(project.id),
      head: await git.resolveRef(project.defaultBranch).catch(() => null),
      clean: await git
        .status({ includeUntracked: false })
        .then((status) => status.clean)
        .catch(() => null),
      runtimeManifest: await context.repos.runtimeManifests.latest(project.id),
      knowledgeSnapshot: await context.knowledge.latest(project.id),
    };
  });

  /**
   * Adds a repository. The heavy half happens in a job, so this answers as soon
   * as the directory has been checked rather than after the whole tree is read.
   */
  router.post('/api/projects', async ({ body }) => {
    const input = requireBody<{ repoPath: string; name?: string; description?: string }>(body, ['repoPath']);
    const project = await context.commands.registerProject({
      repoPath: input.repoPath.trim(),
      ...(input.name ? { name: input.name } : {}),
      ...(input.description ? { description: input.description } : {}),
    });
    return { project };
  });

  router.put('/api/projects/:id', async ({ params, body }) => {
    const input = (body ?? {}) as { name?: string; description?: string; defaultBranch?: string };
    return { project: await context.repos.projects.update(params['id']!, input) };
  });

  /** Queues the setup again, for a project whose first attempt failed. */
  router.post('/api/projects/:id/retry-setup', async ({ params }) => {
    const project = await context.repos.projects.getById(params['id']!);
    if (project.setupState === 'READY') throw new ValidationError(`${project.name} is already prepared`);
    await context.repos.projects.setSetupState(project.id, 'PENDING');
    const job = await context.queue.enqueue({
      taskId: null,
      projectId: project.id,
      jobType: 'PROJECT_SETUP',
      payload: { projectId: project.id },
    });
    return { queued: Boolean(job) };
  });

  router.post('/api/projects/:id/knowledge-refresh', async ({ params }) => {
    const project = await context.repos.projects.getById(params['id']!);
    const job = await context.queue.enqueue({
      taskId: null,
      projectId: project.id,
      jobType: 'KNOWLEDGE_REFRESH',
      payload: { projectId: project.id },
    });
    return { queued: Boolean(job) };
  });

  /**
   * Removes a project, its history and the files on disk that belonged to it.
   *
   * The repository itself is never touched: it is the owner's code and was only
   * ever read and copied into worktrees. What goes is everything this system
   * accumulated about it, which is the only thing it is entitled to delete.
   */
  router.delete('/api/projects/:id', async ({ params, query }) => {
    const project = await context.repos.projects.getById(params['id']!);
    if (project.kind === 'INSTALLATION') {
      throw new ValidationError('The installation cannot be removed from itself.');
    }

    const active = (await context.repos.tasks.listWithActiveJobs()).filter((task) => task.projectId === project.id);
    if (active.length > 0 && query.get('force') !== 'true') {
      throw new ValidationError(
        `${active.length} task(s) in this project are still running: ${active
          .map((task) => task.storyTitle)
          .slice(0, 3)
          .join(', ')}. Stop them first, or pass force=true.`,
      );
    }

    const config = loadConfig();
    const tasks = await context.repos.tasks.listByProject(project.id, 1000);
    await context.repos.projects.remove(project.id);

    // The database cascade takes the rows; these are the directories those rows
    // pointed at. Removal is best-effort on purpose: a project is gone from the
    // cockpit either way, and a leftover directory is tidier to find than a
    // half-deleted project.
    const removed: string[] = [];
    for (const task of tasks) {
      const workspace = path.join(config.paths.workspacesRoot, `task-${task.id}`);
      await rm(workspace, { recursive: true, force: true })
        .then(() => removed.push(workspace))
        .catch(() => undefined);
    }
    const artifacts = path.join(config.paths.artifactsRoot, project.id);
    await rm(artifacts, { recursive: true, force: true })
      .then(() => removed.push(artifacts))
      .catch(() => undefined);

    return { removed: project.id, name: project.name, directoriesRemoved: removed.length };
  });
}
