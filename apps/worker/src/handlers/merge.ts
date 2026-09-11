import { AppError } from '@ai-engine/shared';
import { SETTING_KEYS } from '@ai-engine/domain';
import { GitClient } from '@ai-engine/git';
import { loadAgentPrompt } from '@ai-engine/agents';
import {
  createAgentRunner,
  failRun,
  recordSessionStart,
  resolveAgentVersion,
  runCompletion,
  type JobContext,
} from '../job-context';

/**
 * Putting a finished story into the branch you actually work on.
 *
 * A story leaves a branch. Nothing has been done with it until someone decides
 * to take it, and that decision is a button rather than a policy, because the
 * one thing worse than a story that has to be merged by hand is a story that
 * merged itself into your work branch while you were reading the report.
 *
 * The order is rebase, then merge, then push. Rebasing first is what makes the
 * merge itself boring: by the time it runs, the story sits on top of the work
 * branch and the merge is a fast forward in all but name. It also moves the
 * conflict, when there is one, to the step where the story's own commits are
 * being replayed one at a time, which is where the conflict is smallest and
 * most legible.
 */

const COMMIT_AUTHOR = { name: 'Story Builder', email: 'story-builder@localhost' };

/**
 * Leaves the conflict exactly where it is, and says so.
 *
 * The temptation is to abort and report cleanly. That would throw away the one
 * thing the person needs: a working tree with the conflict markers in it, which
 * they can open in the editor they already have open. So the tree stays as git
 * left it, the project is marked as holding an unfinished merge — which stops
 * the queue from starting anything else in that directory — and the files are
 * recorded so the cockpit can name them.
 */
async function parkConflict(context: JobContext, stage: 'rebase' | 'merge', files: string[]): Promise<void> {
  await context.repos.tasks.recordMergeConflicts(context.task.id, files);
  await context.repos.projects.setMergeConflict(context.project.id, context.task.id);
  await context.events.append({
    projectId: context.project.id,
    taskId: context.task.id,
    eventType: 'MergeConflicted',
    actorType: 'worker',
    actorId: context.workerId,
    payload: { stage, files },
  });
  context.logger.warn('the merge stopped on conflicts and is waiting for a decision', { stage, files });
}

/** Pushes the work branch when the token actually grants write, and says why not otherwise. */
async function pushWorkBranch(context: JobContext, git: GitClient): Promise<string | null> {
  if (context.project.remoteAccess !== 'WRITE') {
    return context.project.remoteUrl
      ? `merged locally; the token does not grant write access to ${context.project.remoteUrl}`
      : 'merged locally; this project has no remote';
  }
  const token = await context.settings.text(SETTING_KEYS.githubToken);
  const push = await git.push('origin', context.project.workBranch, { token });
  return push.exitCode === 0 ? null : `merged locally; the push failed: ${push.stderr.trim()}`;
}

/**
 * The merge button and every route out of a conflict, in one job.
 *
 * They are one job rather than four endpoints because they all need the same
 * thing: the project's working directory to themselves, which is what the queue
 * hands out. An endpoint doing this directly would be racing the next story.
 */
export async function handleMergeStory(context: JobContext): Promise<void> {
  const action = String(context.job.payload['action'] ?? 'merge');
  switch (action) {
    case 'continue':
      return continueMerge(context);
    case 'abort':
      return abortMerge(context);
    case 'undo':
      return undoMerge(context);
    default:
      return startMerge(context);
  }
}

async function startMerge(context: JobContext): Promise<void> {
  const git = new GitClient(context.project.repoPath);

  const inProgress = await git.operationInProgress();
  if (inProgress) {
    throw new AppError(
      'merge_in_progress',
      `${context.project.name} already has an unfinished ${inProgress} in its working directory. ` +
        'Finish or abandon that first.',
      409,
    );
  }

  const status = await git.status({ includeUntracked: true });
  if (!status.clean) {
    const names = status.entries.slice(0, 5).map((entry) => entry.path).join(', ');
    throw new AppError(
      'working_tree_dirty',
      `${context.project.name} has uncommitted changes, so nothing can be merged into ${context.project.workBranch}: ` +
        `${names}. Commit or stash them first.`,
      409,
      { files: status.entries.slice(0, 20).map((entry) => entry.path) },
    );
  }

  if (!(await git.branchExists(context.task.branchName))) {
    throw new AppError('branch_missing', `The branch ${context.task.branchName} no longer exists.`, 409);
  }

  // Where the work branch stands right now. This is the undo: one commit,
  // recorded before anything moves, rather than a search through the reflog
  // afterwards when the question is already urgent.
  await git.checkoutBranch(context.project.workBranch);
  const undoCommit = await git.headCommit();

  await git.checkoutBranch(context.task.branchName);
  const rebase = await git.rebase(context.project.workBranch);
  if (!rebase.success) {
    await parkConflict(context, 'rebase', rebase.conflicts);
    return;
  }

  await git.checkoutBranch(context.project.workBranch);
  const merge = await git.mergeBranch(
    context.task.branchName,
    `Merge story: ${context.story.title}`.slice(0, 100),
    COMMIT_AUTHOR,
  );
  if (!merge.merged) {
    await parkConflict(context, 'merge', merge.conflicts);
    return;
  }

  await finishMerge(context, git, undoCommit);
}

/**
 * The last two steps, shared by the clean path and by every route out of a
 * conflict: record the undo point, push if we can, and say what happened.
 */
export async function finishMerge(context: JobContext, git: GitClient, undoCommit: string): Promise<void> {
  await context.repos.tasks.recordMergeConflicts(context.task.id, []);
  await context.repos.projects.setMergeConflict(context.project.id, null);
  await context.repos.tasks.markMerged(context.task.id, undoCommit);

  const caveat = await pushWorkBranch(context, git);
  await context.events.append({
    projectId: context.project.id,
    taskId: context.task.id,
    eventType: 'StoryMerged',
    actorType: 'worker',
    actorId: context.workerId,
    payload: {
      branch: context.task.branchName,
      into: context.project.workBranch,
      undoCommit,
      ...(caveat ? { note: caveat } : {}),
    },
  });
  if (caveat) context.logger.info('merged', { note: caveat });
}

/**
 * Lets an agent try the conflicts, which is the first of the three routes out.
 *
 * It is offered but not taken by default, and that is deliberate. A conflict is
 * the one place where an automatic resolution is at its most dangerous: both
 * sides usually compile, both sides usually pass, and the result of choosing
 * wrongly is a change that silently does half of what two people meant. So the
 * agent resolves, and the merge still stops for a person if anything is left.
 */
export async function handleMergeResolve(context: JobContext): Promise<void> {
  const git = new GitClient(context.project.repoPath);
  const operation = await git.operationInProgress();
  if (!operation) {
    // Someone resolved it by hand in the meantime, which is a perfectly good
    // outcome and not an error.
    await context.repos.projects.setMergeConflict(context.project.id, null);
    await context.repos.tasks.recordMergeConflicts(context.task.id, []);
    return;
  }

  const conflicts = await git.unmergedPaths();
  const prompt = await loadAgentPrompt('implementation', context.installRoot);
  const agentVersionId = await resolveAgentVersion(context, 'implementation', prompt);
  const run = await context.repos.runs.start({
    taskId: context.task.id,
    projectId: context.project.id,
    phase: 'IMPLEMENTATION',
    agentType: 'implementation',
    agentVersionId,
  });

  try {
    const runner = await createAgentRunner({ context, runId: run.id, phase: 'IMPLEMENTATION', allowWeb: false });
    const outcome = await runner.run<{ resolved: boolean; explanation: string }>({
      phase: 'IMPLEMENTATION',
      agentType: 'implementation',
      system: prompt,
      prompt:
        `A ${operation} of the branch ${context.task.branchName} into ${context.project.workBranch} stopped on ` +
        `conflicts in ${context.project.repoPath}.\n\n` +
        `The story was: ${context.story.title}\n\n` +
        `Conflicted files:\n${conflicts.map((file) => `- ${file}`).join('\n')}\n\n` +
        'Resolve each conflict so that both intentions survive. Do not choose one side wholesale ' +
        'unless the two changes genuinely cannot coexist. Do not commit, and do not continue the ' +
        `${operation}: stage the resolved files with git add and stop there. Say plainly in your ` +
        'explanation anything you were unsure about, because a person is going to read it before ' +
        'this is merged.',
      resultInstruction:
        'Return {"resolved": boolean, "explanation": string}. resolved is true only when every ' +
        'conflicted file is staged with no conflict markers left in it.',
      validate: (value) => value as { resolved: boolean; explanation: string },
      onSessionStart: recordSessionStart(context, run.id, false),
    });

    await context.artifacts.put({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: run.id,
      kind: 'merge_resolution',
      contentType: 'text/markdown',
      content: `${outcome.result.explanation}\n\n---\n\n${outcome.transcript}`,
    });
    await context.repos.runs.complete(run.id, runCompletion(outcome));

    const left = await git.unmergedPaths();
    if (left.length > 0) {
      await parkConflict(context, operation, left);
      return;
    }

    // Resolved, but not merged: continuing is a separate decision, and the
    // explanation above is what it should be made on. The cockpit shows it with
    // the same three buttons, one of which is now simply "done".
    context.logger.info('the agent resolved every conflicted file; waiting for a person to accept it');
  } catch (error) {
    await failRun(context, run.id, error);
    throw error;
  }
}

/**
 * The second route out of a conflict, and the default one: you resolved it
 * yourself and you are saying so.
 *
 * It refuses rather than trusting the claim. A tree with conflict markers still
 * in it is exactly what a person means to avoid, and the check costs one command.
 */
async function continueMerge(context: JobContext): Promise<void> {
  const git = new GitClient(context.project.repoPath);
  const left = await git.unmergedPaths();
  if (left.length > 0) {
    throw new AppError(
      'conflicts_remain',
      `${left.length} file(s) are still in conflict: ${left.slice(0, 5).join(', ')}. ` +
        'Resolve them and stage them, then say done again.',
      409,
      { files: left },
    );
  }

  // The work branch has not moved while the conflict sat there, so this is still
  // the commit to undo back to.
  const undoCommit = await git.resolveRef(context.project.workBranch);
  if (!undoCommit) {
    throw new AppError('branch_missing', `${context.project.workBranch} no longer exists.`, 409);
  }

  const operation = await git.operationInProgress();
  if (operation === 'rebase') {
    await git.addAll();
    const rebase = await git.continueRebase();
    if (!rebase.success) {
      await parkConflict(context, 'rebase', rebase.conflicts);
      return;
    }
  } else if (operation === 'merge') {
    await git.addAll();
    await git.commit(`Merge story: ${context.story.title}`.slice(0, 100), COMMIT_AUTHOR);
    await finishMerge(context, git, undoCommit);
    return;
  }

  // A finished rebase leaves the story on top of the work branch, so the merge
  // itself is now the trivial step it was always meant to be.
  await git.checkoutBranch(context.project.workBranch);
  const merge = await git.mergeBranch(
    context.task.branchName,
    `Merge story: ${context.story.title}`.slice(0, 100),
    COMMIT_AUTHOR,
  );
  if (!merge.merged) {
    await parkConflict(context, 'merge', merge.conflicts);
    return;
  }
  await finishMerge(context, git, undoCommit);
}

/**
 * The third route: put everything back and decide later.
 *
 * The story's branch is untouched by this. Abandoning the merge abandons the
 * attempt, not the work, which is the difference that makes it safe to press.
 */
async function abortMerge(context: JobContext): Promise<void> {
  const git = new GitClient(context.project.repoPath);
  const operation = await git.operationInProgress();
  if (operation === 'rebase') await git.abortRebase();
  else if (operation === 'merge') await git.abortMerge();

  await git.checkoutBranch(context.project.workBranch).catch((error: unknown) => {
    context.logger.warn('could not return the directory to the work branch', { error });
  });
  await context.repos.projects.setMergeConflict(context.project.id, null);
  await context.repos.tasks.recordMergeConflicts(context.task.id, []);
  await context.events.append({
    projectId: context.project.id,
    taskId: context.task.id,
    eventType: 'MergeConflicted',
    actorType: 'human',
    actorId: 'cockpit',
    payload: { stage: operation ?? 'none', files: [], abandoned: true },
  });
}

/**
 * Undoes a merge that already happened, with one action.
 *
 * This is the reason the commit was recorded before anything moved. It refuses
 * once the work branch has moved on, because resetting then would silently throw
 * away whatever was committed after the merge, which is someone else's work.
 */
async function undoMerge(context: JobContext): Promise<void> {
  const undoCommit = context.task.mergeUndoCommit;
  if (!undoCommit) {
    throw new AppError('not_merged', 'This story has no recorded merge to undo.', 409);
  }

  const git = new GitClient(context.project.repoPath);
  const status = await git.status({ includeUntracked: true });
  if (!status.clean) {
    throw new AppError(
      'working_tree_dirty',
      `${context.project.name} has uncommitted changes, so the merge cannot be undone without losing them.`,
      409,
    );
  }

  await git.checkoutBranch(context.project.workBranch);
  const head = await git.headCommit();

  // The merge is undoable only while it is still the last thing that happened
  // here: the tip must be the merge commit, and its first parent must be where
  // the branch stood before it. Counting commits would not do — a story of six
  // commits is six commits behind its own merge — and a reset after someone else
  // has committed would take their work with it.
  const firstParent = await git.resolveRef('HEAD^1');
  if (firstParent !== undoCommit) {
    throw new AppError(
      'branch_moved_on',
      `${context.project.workBranch} has moved on since this was merged, so undoing it here would discard whatever ` +
        'came after. Revert the merge commit instead.',
      409,
      { head, undoCommit, firstParent },
    );
  }

  await git.resetHard(undoCommit);
  await context.repos.tasks.clearMerge(context.task.id);
  await context.events.append({
    projectId: context.project.id,
    taskId: context.task.id,
    eventType: 'MergeUndone',
    actorType: 'human',
    actorId: 'cockpit',
    payload: { from: head, to: undoCommit, branch: context.project.workBranch },
  });
}
