import { createLogger } from '@ai-engine/shared';
import { runLearningAgent } from '@ai-engine/agents';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import { detectRuntimeManifest, manifestGaps, toYaml, validateRuntimeManifest } from '@ai-engine/runtime-manifest';
import { ConflictEngine } from '@ai-engine/conflict-engine';
import { GitClient } from '@ai-engine/git';
import {
  buildProjectContext,
  createAgentRunner,
  createExecutor,
  recordEngineMetrics,
  recordSessionStart,
  resumableSessionFor,
  runCompletion,
  type JobContext,
} from '../job-context';
import type { ProjectJobContext } from '../project-context';
import { releaseDirectory } from '../project-directory';

const logger = createLogger('maintenance');

/**
 * Extracts the reasoning behind human corrections and writes it into the
 * Project Brain. This is what makes the system get better over time.
 */
export async function handleLearning(context: JobContext): Promise<void> {
  const reviews = await context.repos.reviews.listByTask(context.task.id);
  const engineering = reviews.find((review) => review.kind === 'ENGINEERING');
  if (!engineering) return;

  const notes = await context.repos.reviews.listNotes(engineering.id);
  const versions = await context.repos.reviews.listVersions(engineering.id);
  const qaRuns = await context.repos.qaRuns.listByTask(context.task.id);

  // The session is recorded before the process exists, as every other phase
  // does. This was the one agent that did not, which made it the one agent whose
  // death left no record of which conversation it died in.
  const previousSessionId = await resumableSessionFor(context, 'FINAL_REPORT');
  const learningRun = await context.repos.runs.start({
    taskId: context.task.id,
    projectId: context.project.id,
    phase: 'FINAL_REPORT',
    agentType: 'learning',
    sessionId: previousSessionId,
    ...(previousSessionId ? { resumed: true } : {}),
  });
  const { result, outcome } = await runLearningAgent({
    runner: await createAgentRunner({ context, runId: learningRun.id, phase: 'FINAL_REPORT' }),
    projectContext: await buildProjectContext(context),
    storyBody: context.revision.body,
    notes,
    reviewBefore: versions[0]?.document ?? null,
    reviewAfter: versions[versions.length - 1]?.document ?? null,
    qaSummaries: qaRuns.flatMap((run) => run.findings.map((finding) => finding.summary)),
    installRoot: context.installRoot,
    onSessionStart: recordSessionStart(context, learningRun.id, Boolean(previousSessionId)),
    ...(previousSessionId ? { resumeSessionId: previousSessionId } : {}),
  });
  // The fifth agent used to record nothing at all, which made it the one agent
  // whose spend a per-agent breakdown could not show.
  await context.repos.runs.complete(learningRun.id, outcome ? runCompletion(outcome) : undefined);
  if (outcome) await recordEngineMetrics(context, 'learning', outcome);

  for (const principle of result.principles) {
    const { principle: stored, created } = await context.brain.recordPrinciple(context.project.id, principle, {
      taskId: context.task.id,
    });
    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      eventType: 'PrincipleLearned',
      actorType: 'agent',
      actorId: 'learning',
      payload: { principleId: stored.id, created, category: stored.category },
    });
  }

  for (const invariant of result.invariants) {
    const { invariant: stored, created } = await context.brain.recordInvariant(context.project.id, invariant);
    if (created) {
      await context.events.append({
        projectId: context.project.id,
        taskId: context.task.id,
        eventType: 'InvariantExtracted',
        actorType: 'agent',
        actorId: 'learning',
        payload: { invariantId: stored.id },
      });
    }
  }

  await context.repos.metrics.record({
    projectId: context.project.id,
    taskId: context.task.id,
    name: 'human_corrections',
    value: notes.length,
  });
  await context.repos.metrics.record({
    projectId: context.project.id,
    taskId: context.task.id,
    name: 'review_regenerations',
    value: Math.max(0, versions.length - 1),
  });

  // Locks are only released once everything that could depend on them is done.
  await new ConflictEngine(context.db).releaseLocks(context.task.id);
}

/**
 * Rebuilds the knowledge snapshot for the current head of the default branch.
 *
 * This belongs to the project rather than to any task, which is why it takes a
 * project context. It used to be anchored to an arbitrary task purely so it had
 * something to hang a job on, and a project with no tasks yet could not refresh
 * its knowledge at all.
 */
export async function handleKnowledgeRefresh(context: ProjectJobContext): Promise<void> {
  const git = new GitClient(context.project.repoPath);
  const head = (await git.resolveRef(context.project.defaultBranch)) ?? (await git.headCommit());
  const knowledge = new KnowledgeService(context.db);
  const { snapshot } = await knowledge.buildSnapshot({
    projectId: context.project.id,
    gitCommit: head,
    repositoryPath: context.project.repoPath,
  });
  await context.events.append({
    projectId: context.project.id,
    eventType: 'KnowledgeSnapshotCreated',
    actorType: 'worker',
    actorId: context.workerId,
    payload: { snapshotId: snapshot.id, commit: head },
  });
}

/**
 * Detects how the project builds and tests, then proves it by running those
 * commands in a sandbox. A manifest that has not run is not trusted.
 */
export async function handleRuntimeManifest(context: JobContext): Promise<void> {
  const detected = await detectRuntimeManifest(context.project.repoPath);
  const record = await context.repos.runtimeManifests.create(context.project.id, detected);
  const gaps = manifestGaps(detected);

  const executor = createExecutor(context.project.repoPath);
  const validation = await validateRuntimeManifest(
    detected,
    { run: (input) => executor.run({ command: input.command, timeoutMs: input.timeoutMs }) },
    { runTests: false },
  );

  await context.repos.runtimeManifests.markValidated(record.id, validation.valid, validation.log);
  await context.artifacts.put({
    projectId: context.project.id,
    taskId: context.task.id,
    kind: 'runtime_manifest',
    contentType: 'text/plain',
    content: toYaml(detected),
  });

  await context.events.append({
    projectId: context.project.id,
    taskId: context.task.id,
    eventType: 'RuntimeManifestGenerated',
    actorType: 'worker',
    actorId: context.workerId,
    payload: { manifestId: record.id, validated: validation.valid, gaps },
  });
}

/**
 * Gives the project directory back after a story ends.
 *
 * A story that is stopped while nothing of it is running still holds the
 * directory: it is on its branch. This commits whatever is there and returns the
 * directory to the work branch, so the next story finds it clean and the person
 * finds it where they left it.
 */
export async function handleReleaseDirectory(context: JobContext): Promise<void> {
  const { committed } = await releaseDirectory(context);
  await context.events.append({
    projectId: context.project.id,
    taskId: context.task.id,
    eventType: 'CheckpointCreated',
    actorType: 'worker',
    actorId: context.workerId,
    payload: { releasedTo: context.task.returnedToBranch ?? context.project.workBranch, committed },
  });
}
