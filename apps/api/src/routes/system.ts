import { HttpRouter, loadConfig, RESPONSE_HANDLED, ValidationError } from '@ai-engine/shared';
import { GitClient, readInstallationVersion } from '@ai-engine/git';
import { fetchLatestRelease } from '@ai-engine/github';
import { assertCanApply, startApply } from '../apply';
import { claudeCliAvailable } from '@ai-engine/claude-code';
import { checkBaseDrift } from '@ai-engine/conflict-engine';
import { primaryProjectId, type ApiContext } from '../context';

/** System status, artifacts, conflicts and metrics. */
export function registerSystemRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/health', async () => {
    const config = loadConfig();
    let sandboxManager = false;
    try {
      const response = await fetch(`${config.service.sandboxManagerUrl}/health`);
      sandboxManager = response.ok;
    } catch {
      sandboxManager = false;
    }
    // The engine that actually runs the agents, and whether it is usable.
    const engine = config.agents.engine;
    const cli = engine === 'claude-code' ? await claudeCliAvailable(config.agents.claudeBinary) : { available: true, version: null };

    return {
      status: 'ok',
      database: await context.db.healthy(),
      sandboxManager,
      agentEngine: engine,
      agentEngineReady: cli.available,
      claudeCliVersion: cli.version,
      aiProvider: engine === 'claude-code' ? 'claude-code CLI login' : config.ai.provider,
      model: engine === 'claude-code' ? config.agents.claudeModel ?? 'CLI default' : config.ai.model,
      sandboxEnabled: config.sandbox.enabled,
    };
  });

  router.get('/api/system/version', async () => {
    const config = loadConfig();
    const remote = await new GitClient(config.paths.installRoot).remoteUrl().catch(() => null);
    const latest = remote ? await fetchLatestRelease(remote) : null;
    const version = await readInstallationVersion(config.paths.installRoot, latest?.tag ?? null);
    return {
      installRoot: config.paths.installRoot,
      projectRoot: config.paths.projectRoot,
      releaseUrl: latest?.url ?? null,
      ...version,
    };
  });

  router.get('/api/projects', async () => ({ projects: await context.repos.projects.list() }));

  /**
   * Moves this installation to the newest release. The candidate is a tag
   * rather than a task branch; everything after that is the same path, so an
   * upgrade and a change of our own are applied and rolled back identically.
   */
  router.post('/api/system/sync', async () => {
    const installation = await context.repos.projects.findInstallation();
    if (!installation) {
      throw new ValidationError('This installation is not registered as a project. Run "ai-engine init" again.');
    }

    const git = new GitClient(installation.repoPath);
    const remote = await git.remoteUrl();
    if (!remote) throw new ValidationError('The installation has no remote to update from');

    const latest = await fetchLatestRelease(remote);
    if (!latest) throw new ValidationError('No published release could be read from the remote');

    const version = await readInstallationVersion(installation.repoPath, latest.tag);
    if (version.tag === latest.tag && version.localCommits === 0) {
      throw new ValidationError(`Already on ${latest.tag}`);
    }

    await assertCanApply(context, installation);
    const record = await startApply(context, {
      installation,
      taskId: null,
      source: 'UPSTREAM',
      candidateRef: latest.tag,
    });
    return { applyId: record.id, status: record.status, candidateRef: record.candidateRef };
  });

  router.get('/api/system/apply', async () => {
    const installation = await context.repos.projects.findInstallation();
    if (!installation) return { installation: null, apply: null };
    return {
      installation,
      apply: await context.repos.installationApplies.latest(installation.id),
    };
  });

  router.get('/api/system/status', async ({ query }) => {
    const projectId = await primaryProjectId(context, query.get('projectId'));
    const project = await context.repos.projects.getById(projectId);
    const active = await context.repos.tasks.listActive(projectId);
    const jobs = await context.queue.stats();
    const conflicts = await context.conflicts.allOpenConflicts();
    const manifest = await context.repos.runtimeManifests.latest(projectId);
    const snapshot = await context.knowledge.latest(projectId);

    const git = new GitClient(project.repoPath);
    const head = await git.resolveRef(project.defaultBranch).catch(() => null);

    return {
      project,
      activeTasks: active.length,
      tasks: active,
      jobs,
      conflicts,
      runtimeManifest: manifest,
      knowledgeSnapshot: snapshot,
      repository: { defaultBranch: project.defaultBranch, head, remoteUrl: project.remoteUrl },
    };
  });

  router.get('/api/system/events', async ({ query }) => {
    const projectId = await primaryProjectId(context, query.get('projectId'));
    const limit = Number.parseInt(query.get('limit') ?? '100', 10);
    return { events: await context.events.listByProject(projectId, limit) };
  });

  router.get('/api/system/metrics', async ({ query }) => {
    const projectId = await primaryProjectId(context, query.get('projectId'));
    return { metrics: await context.repos.metrics.summary(projectId) };
  });

  router.get('/api/conflicts', async () => ({ conflicts: await context.conflicts.allOpenConflicts() }));

  router.get('/api/tasks/:id/base-drift', async ({ params }) => {
    const task = await context.repos.tasks.getById(params['id']!);
    const project = await context.repos.projects.getById(task.projectId);
    const drift = await checkBaseDrift({
      repositoryPath: project.repoPath,
      baseBranch: task.baseBranch,
      baseCommit: task.baseCommit,
    });
    if (drift.moved && !task.baseMoved) {
      await context.repos.tasks.update(task.id, { baseMoved: true });
    }
    return drift;
  });

  router.get('/api/artifacts/:id', async ({ params, query, response }) => {
    const { record, content } = await context.artifacts.get(params['id']!);
    if (query.get('download') === 'true') {
      response.writeHead(200, {
        'content-type': record.contentType,
        'content-disposition': `attachment; filename="${record.kind}-${record.id.slice(0, 8)}"`,
      });
      response.end(content);
      return RESPONSE_HANDLED;
    }
    return { artifact: record, content: content.toString('utf8') };
  });

  router.get('/api/jobs', async () => ({ stats: await context.queue.stats() }));

  router.post('/api/system/knowledge-refresh', async ({ query }) => {
    const projectId = await primaryProjectId(context, query.get('projectId'));
    const tasks = await context.repos.tasks.listByProject(projectId, 1);
    const anchor = tasks[0];
    if (!anchor) return { queued: false, reason: 'No task exists yet to anchor the refresh job' };
    const job = await context.queue.enqueue({ taskId: anchor.id, jobType: 'KNOWLEDGE_REFRESH', payload: { taskId: anchor.id } });
    return { queued: Boolean(job), job };
  });
}
