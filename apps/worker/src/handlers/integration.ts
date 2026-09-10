import { AppError, loadConfig } from '@ai-engine/shared';
import { changedFiles, GitClient } from '@ai-engine/git';
import { createRemoteProvider } from '@ai-engine/github';
import { rebaseOntoBase } from '@ai-engine/conflict-engine';
import { commitWorkspace, createExecutor, workspacePathFor, type JobContext } from '../job-context';

/**
 * Runs before every pull request: rebase onto the current base, re-run the
 * tests on the rebased result, and only then allow a push.
 */
export async function handleIntegrationValidation(context: JobContext): Promise<void> {
  const config = loadConfig();
  const workspacePath = workspacePathFor(context.task.id);
  const git = new GitClient(workspacePath);

  // Anything the last phase left behind is committed so the rebase can move it.
  await commitWorkspace(context, git);

  const rebase = await rebaseOntoBase({ workspacePath, baseBranch: context.task.baseBranch });
  if (!rebase.rebased) {
    await context.orchestrator.block(
      context.task.id,
      `The task branch cannot be rebased onto ${context.task.baseBranch}. Conflicting files: ${rebase.conflicts.join(', ')}`,
      { type: 'worker', id: context.workerId },
    );
    return;
  }

  if (rebase.newBaseCommit && rebase.newBaseCommit !== context.task.baseCommit) {
    await context.repos.tasks.update(context.task.id, { baseCommit: rebase.newBaseCommit, baseMoved: false });
    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      eventType: 'BaseMoved',
      actorType: 'worker',
      actorId: context.workerId,
      payload: { newBaseCommit: rebase.newBaseCommit },
    });
  }

  const manifest = await context.repos.runtimeManifests.latest(context.project.id);
  const executor = createExecutor(context.task.id);
  const commands = [...(manifest?.manifest.build.commands ?? []), ...(manifest?.manifest.test.commands ?? [])];

  for (const command of commands) {
    const outcome = await executor.run({
      command,
      cwd: workspacePath,
      timeoutMs: config.sandbox.commandTimeoutMs,
    });
    const artifact = await context.artifacts.put({
      projectId: context.project.id,
      taskId: context.task.id,
      kind: 'integration_log',
      content: `$ ${command}\nexit code: ${outcome.exitCode}\n\n${outcome.stdout}\n${outcome.stderr}`,
      metadata: { command, exitCode: outcome.exitCode },
    });
    await context.repos.testRuns.record({
      taskId: context.task.id,
      command,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      logArtifactId: artifact.id,
    });
    if (outcome.exitCode !== 0) {
      await context.orchestrator.transition({
        taskId: context.task.id,
        to: 'FIX_REQUIRED',
        actor: { type: 'worker', id: context.workerId },
        reason: `"${command}" failed after rebasing onto the current base`,
        enqueue: { jobType: 'FIX', payload: { reason: 'integration_failure' } },
      });
      return;
    }
  }

  const changes = await changedFiles(git, context.task.baseCommit);
  await context.repos.gitChanges.replaceForTask(
    context.task.id,
    changes.map((change) => ({
      filePath: change.filePath,
      changeType: change.changeType,
      insertions: change.insertions,
      deletions: change.deletions,
    })),
  );

  const hasRemote = Boolean(context.project.remoteUrl);
  await context.orchestrator.transition({
    taskId: context.task.id,
    to: 'PUSHING',
    actor: { type: 'worker', id: context.workerId },
    enqueue: { jobType: 'PUSH_AND_PR', payload: { hasRemote } },
  });
}

/**
 * The only place in the system that pushes. It runs after an explicit human
 * approval and never before.
 */
export async function handlePushAndPullRequest(context: JobContext): Promise<void> {
  const approval = await context.repos.approvals.findLatest(context.task.id, 'PR');
  if (!approval || approval.decision !== 'APPROVED') {
    throw new AppError('not_approved', 'A pull request requires an explicit human approval', 403);
  }

  const workspacePath = workspacePathFor(context.task.id);
  const git = new GitClient(workspacePath);
  const headCommit = await git.headCommit();
  await context.repos.gitChanges.recordRef(context.task.id, context.task.branchName, headCommit, 'task_head');

  // An installation is never pushed. Its work waits on a local branch until a
  // human applies it, which stops the services, rebuilds and restarts onto it.
  if (context.project.kind === 'INSTALLATION') {
    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      eventType: 'InstallationCandidateReady',
      actorType: 'worker',
      actorId: context.workerId,
      payload: { candidateRef: context.task.branchName, commit: headCommit },
    });
    await context.orchestrator.transition({
      taskId: context.task.id,
      to: 'COMPLETED',
      actor: { type: 'worker', id: context.workerId },
      reason: 'ready to be applied to the installation',
      enqueue: { jobType: 'LEARNING' },
    });
    return;
  }

  const provider = createRemoteProvider(context.project.remoteUrl);
  if (!provider || !provider.isConfigured()) {
    // Without a configured remote the task still completes; the branch is local.
    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      eventType: 'TaskCompleted',
      actorType: 'worker',
      actorId: context.workerId,
      payload: { localBranch: context.task.branchName, commit: headCommit, reason: 'no configured remote' },
    });
    await context.orchestrator.transition({
      taskId: context.task.id,
      to: 'COMPLETED',
      actor: { type: 'worker', id: context.workerId },
      reason: 'completed as a local branch because no GitHub remote is configured',
      enqueue: { jobType: 'LEARNING' },
    });
    return;
  }

  // The token is injected per invocation. Without one the push depends on an
  // ambient credential helper, which a headless worker usually does not have.
  const token = loadConfig().github.token;
  const push = await git.push('origin', context.task.branchName, { token });
  if (push.exitCode !== 0) {
    const hint = token
      ? ''
      : ' No GITHUB_TOKEN is configured, so the push relied on the local Git credential helper.';
    await context.orchestrator.block(context.task.id, `Push failed: ${push.stderr}${hint}`, {
      type: 'worker',
      id: context.workerId,
    });
    return;
  }

  const reportArtifact = await context.repos.artifacts.latestByKind(context.task.id, 'final_report');
  const body = reportArtifact
    ? (await context.artifacts.getText(reportArtifact.id)).slice(0, 60_000)
    : `Implements: ${context.story.title}`;

  const pullRequest = await provider.createPullRequest({
    title: context.story.title.slice(0, 120),
    body,
    headBranch: context.task.branchName,
    baseBranch: context.task.baseBranch,
  });

  await context.events.append({
    projectId: context.project.id,
    taskId: context.task.id,
    eventType: 'PRCreated',
    actorType: 'worker',
    actorId: context.workerId,
    payload: { number: pullRequest.number, url: pullRequest.url },
  });

  await context.orchestrator.transition({
    taskId: context.task.id,
    to: 'PR_CREATED',
    actor: { type: 'worker', id: context.workerId },
    payload: { url: pullRequest.url, number: pullRequest.number },
  });
  await context.orchestrator.transition({
    taskId: context.task.id,
    to: 'COMPLETED',
    actor: { type: 'worker', id: context.workerId },
    enqueue: { jobType: 'LEARNING' },
  });
}
