import { HttpRouter, ValidationError } from '@ai-engine/shared';
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
    const input = (body ?? {}) as {
      name?: string;
      description?: string;
      defaultBranch?: string;
      workBranch?: string;
    };
    const project = await context.repos.projects.getById(params['id']!);

    // The branch stories start from and are merged back into. It has to exist,
    // because the alternative is finding out at the end of a story that there
    // was nowhere to put it.
    if (input.workBranch && input.workBranch !== project.workBranch) {
      const git = new GitClient(project.repoPath);
      if (!(await git.branchExists(input.workBranch))) {
        throw new ValidationError(`${project.name} has no branch called ${input.workBranch}`);
      }
    }
    return { project: await context.repos.projects.update(project.id, input) };
  });

  /** The branches a project could be worked against, for the picker. */
  router.get('/api/projects/:id/branches', async ({ params }) => {
    const project = await context.repos.projects.getById(params['id']!);
    return { branches: await new GitClient(project.repoPath).listBranches() };
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
   * Removes a project and everything this system accumulated about it.
   *
   * The repository itself is never touched, and there is nothing of ours in it
   * to remove: nothing was ever written there. What goes is rows, which is the
   * only thing this system is entitled to delete.
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

    await context.repos.projects.remove(project.id);

    // Nothing else to clean up. Everything this project accumulated — stories,
    // runs, findings, artifacts — was a row, and the cascade took all of it. The
    // directory on disk is the person's own repository and is left exactly as it
    // was found, minus the branches their stories made.
    return { removed: project.id, name: project.name };
  });
}
