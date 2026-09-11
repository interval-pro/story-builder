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
 *
 * "In flight" means a job is pending or running. It used to mean any task not in
 * a terminal state, which counted a review waiting for approval and a task that
 * had been blocked for a day: an update was refused twice with the words "tasks
 * are still running" while nothing was running at all. A task waiting at a human
 * gate survives a restart perfectly well, because its state is in Postgres and
 * Postgres stays up.
 */
export async function assertCanApply(context: ApiContext, installation: Project): Promise<void> {
  const running = await context.repos.installationApplies.findRunning();
  if (running) throw new ValidationError('Another apply is already running');

  const inFlight = await context.repos.tasks.listWithActiveJobs();
  if (inFlight.length > 0) {
    // Named, because "N tasks" sends a person hunting and the list is two lines.
    const named = inFlight
      .slice(0, 3)
      .map((task) => `${task.storyTitle} (${task.projectName})`)
      .join('; ');
    const more = inFlight.length > 3 ? `, and ${inFlight.length - 3} more` : '';
    throw new ValidationError(
      `${inFlight.length} task(s) have work in progress: ${named}${more}. Applying stops every service, so let them ` +
        'finish or stop them first. Tasks waiting for a decision do not need to be cleared.',
    );
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
