import { spawn } from 'node:child_process';
import path from 'node:path';
import { HttpRouter, loadConfig, ValidationError } from '@ai-engine/shared';
import { transitionsFrom } from '@ai-engine/domain';
import { GitClient } from '@ai-engine/git';
import { actorFrom, primaryProjectId, requireBody, type ApiContext } from '../context';

/** Task state, execution progress and the human control actions. */
export function registerTaskRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/tasks', async ({ query }) => {
    const projectId = await primaryProjectId(context, query.get('projectId'));
    const tasks = query.get('active') === 'true'
      ? await context.repos.tasks.listActive(projectId)
      : await context.repos.tasks.listByProject(projectId);
    return { tasks };
  });

  router.get('/api/tasks/:id', async ({ params }) => {
    const task = await context.repos.tasks.getById(params['id']!);
    const story = await context.repos.stories.getById(task.storyId);
    const revision = await context.repos.stories.getRevision(task.storyRevisionId);
    const reviews = await context.repos.reviews.listByTask(task.id);
    const approvals = await context.repos.approvals.listByTask(task.id);
    const runs = await context.repos.runs.listByTask(task.id);
    const qaRuns = await context.repos.qaRuns.listByTask(task.id);
    const testRuns = await context.repos.testRuns.listByTask(task.id);
    const conflicts = await context.conflicts.openConflicts(task.id);
    const sandbox = await context.repos.sandboxes.findActiveByTask(task.id);
    const activeJob = await context.queue.findActiveForTask(task.id);
    const changes = await context.repos.gitChanges.listForTask(task.id);
    const project = await context.repos.projects.getById(task.projectId);
    const applies = await context.repos.installationApplies.findByTask(task.id);

    return {
      task,
      project,
      applies,
      story,
      revision,
      reviews,
      approvals,
      runs,
      qaRuns,
      testRuns,
      conflicts,
      sandbox,
      activeJob,
      changes,
      allowedTransitions: transitionsFrom(task.state),
    };
  });

  router.get('/api/tasks/:id/events', async ({ params, query }) => {
    const limit = Number.parseInt(query.get('limit') ?? '300', 10);
    return { events: await context.events.listByTask(params['id']!, limit) };
  });

  router.get('/api/tasks/:id/tool-calls', async ({ params, query }) => {
    const limit = Number.parseInt(query.get('limit') ?? '50', 10);
    return { toolCalls: await context.repos.toolCalls.listRecentByTask(params['id']!, limit) };
  });

  router.get('/api/tasks/:id/artifacts', async ({ params, query }) => {
    const kind = query.get('kind');
    return { artifacts: await context.repos.artifacts.listByTask(params['id']!, kind ?? undefined) };
  });

  router.get('/api/tasks/:id/checkpoints', async ({ params }) => {
    return { checkpoints: await context.repos.checkpoints.listByTask(params['id']!) };
  });

  router.get('/api/tasks/:id/final-report', async ({ params }) => {
    const artifact = await context.repos.artifacts.latestByKind(params['id']!, 'final_report');
    if (!artifact) return { report: null };
    return { report: await context.artifacts.getText(artifact.id), artifact };
  });

  /**
   * Applies a finished installation task to the engine. Everything stops while
   * it runs, including this process, so the work is handed to a detached
   * process and the answer here only says that it started.
   */
  router.post('/api/tasks/:id/apply', async ({ params }) => {
    const task = await context.repos.tasks.getById(params['id']!);
    const project = await context.repos.projects.getById(task.projectId);
    if (project.kind !== 'INSTALLATION') {
      throw new ValidationError('Only a task against the installation can be applied to it');
    }
    if (task.state !== 'COMPLETED') {
      throw new ValidationError(`The task is ${task.state}. Only a completed task can be applied.`);
    }

    const running = await context.repos.installationApplies.findRunning();
    if (running) throw new ValidationError('Another apply is already running');

    for (const candidate of await context.repos.projects.list()) {
      const active = await context.repos.tasks.listActive(candidate.id);
      if (active.length > 0) {
        throw new ValidationError(
          `${active.length} task(s) are still running. Applying stops every service, so let them finish first.`,
        );
      }
    }

    const git = new GitClient(project.repoPath);
    const status = await git.status({ includeUntracked: false });
    if (!status.clean) {
      throw new ValidationError('The installation has uncommitted changes. Commit or discard them first.');
    }

    const record = await context.repos.installationApplies.start({
      projectId: project.id,
      taskId: task.id,
      source: 'TASK',
      candidateRef: task.branchName,
      previousCommit: await git.headCommit(),
    });

    await context.events.append({
      projectId: project.id,
      taskId: task.id,
      eventType: 'InstallationApplyStarted',
      actorType: 'human',
      actorId: 'cockpit',
      payload: { applyId: record.id, candidateRef: record.candidateRef },
    });

    // Detached and unreferenced, so it outlives the API being stopped.
    const installRoot = loadConfig().paths.installRoot;
    const child = spawn(process.execPath, [path.join(installRoot, 'apps', 'cli', 'dist', 'apply.js'), record.id], {
      cwd: installRoot,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();

    return { applyId: record.id, status: record.status, candidateRef: record.candidateRef };
  });

  router.post('/api/tasks/:id/pause', async ({ params, headers }) => {
    return { task: await context.commands.pause(params['id']!, actorFrom(headers as Record<string, unknown>)) };
  });

  router.post('/api/tasks/:id/resume', async ({ params, headers }) => {
    return { task: await context.commands.resume(params['id']!, actorFrom(headers as Record<string, unknown>)) };
  });

  router.post('/api/tasks/:id/stop', async ({ params, headers }) => {
    return { task: await context.commands.stop(params['id']!, actorFrom(headers as Record<string, unknown>)) };
  });

  router.post('/api/tasks/:id/retry', async ({ params, headers }) => {
    return { task: await context.commands.retry(params['id']!, actorFrom(headers as Record<string, unknown>)) };
  });

  router.post('/api/tasks/:id/unblock', async ({ params, body, headers }) => {
    const input = requireBody<{ target: 'ANALYSIS_QUEUED' | 'IMPLEMENTATION_QUEUED' | 'FIX_REQUIRED' }>(body, ['target']);
    if (!['ANALYSIS_QUEUED', 'IMPLEMENTATION_QUEUED', 'FIX_REQUIRED'].includes(input.target)) {
      throw new ValidationError('target must be ANALYSIS_QUEUED, IMPLEMENTATION_QUEUED or FIX_REQUIRED');
    }
    return {
      task: await context.commands.unblock({
        taskId: params['id']!,
        target: input.target,
        actor: actorFrom(headers as Record<string, unknown>),
      }),
    };
  });
}
