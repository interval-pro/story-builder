import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadConfig, ValidationError } from '@ai-engine/shared';
import type { InstallationApply, Project } from '@ai-engine/domain';
import { GitClient } from '@ai-engine/git';
import type { ApiContext } from './context';

/**
 * Applying replaces the running engine, so it is only allowed when nothing
 * else is in flight and the installation has no work of its own that would be
 * lost. Every reason it is refused is one the cockpit can show.
 */
export async function assertCanApply(context: ApiContext, installation: Project): Promise<void> {
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

  const status = await new GitClient(installation.repoPath).status({ includeUntracked: false });
  if (!status.clean) {
    throw new ValidationError('The installation has uncommitted changes. Commit or discard them first.');
  }
}

export async function startApply(
  context: ApiContext,
  input: { installation: Project; taskId: string | null; source: 'TASK' | 'UPSTREAM'; candidateRef: string },
): Promise<InstallationApply> {
  const git = new GitClient(input.installation.repoPath);
  const record = await context.repos.installationApplies.start({
    projectId: input.installation.id,
    taskId: input.taskId,
    source: input.source,
    candidateRef: input.candidateRef,
    previousCommit: await git.headCommit(),
  });

  await context.events.append({
    projectId: input.installation.id,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    eventType: 'InstallationApplyStarted',
    actorType: 'human',
    actorId: 'cockpit',
    payload: { applyId: record.id, source: input.source, candidateRef: record.candidateRef },
  });

  // Detached and unreferenced, so it outlives this process being stopped.
  const installRoot = loadConfig().paths.installRoot;
  const child = spawn(process.execPath, [path.join(installRoot, 'apps', 'cli', 'dist', 'apply.js'), record.id], {
    cwd: installRoot,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  return record;
}
