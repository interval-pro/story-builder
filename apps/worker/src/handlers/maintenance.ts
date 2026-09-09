import { createLogger } from '@ai-engine/shared';
import { runLearningAgent } from '@ai-engine/agents';
import { KnowledgeService } from '@ai-engine/project-knowledge';
import { detectRuntimeManifest, manifestGaps, toYaml, validateRuntimeManifest } from '@ai-engine/runtime-manifest';
import { ConflictEngine } from '@ai-engine/conflict-engine';
import { GitClient } from '@ai-engine/git';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildProjectContext, createAiProvider, createExecutor, type JobContext } from '../job-context';
import { SandboxClient } from '../sandbox-client';

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

  const result = await runLearningAgent({
    provider: createAiProvider(),
    projectContext: await buildProjectContext(context),
    storyBody: context.revision.body,
    notes,
    reviewBefore: versions[0]?.document ?? null,
    reviewAfter: versions[versions.length - 1]?.document ?? null,
    qaSummaries: qaRuns.flatMap((run) => run.findings.map((finding) => finding.summary)),
    projectRoot: context.project.repoPath,
    logger: context.logger,
  });

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

/** Rebuilds the knowledge snapshot for the current head of the base branch. */
export async function handleKnowledgeRefresh(context: JobContext): Promise<void> {
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

  const sandbox = new SandboxClient(context.project.repoPath);
  await sandbox.ensure({
    taskId: context.task.id,
    branch: `ai/runtime-manifest-${context.task.id.slice(0, 8)}`,
    baseCommit: context.task.baseCommit,
    mode: 'READ_WRITE',
  });

  const executor = createExecutor(context.task.id);
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

  const manifestPath = path.join(context.project.repoPath, '.ai-engineering', 'runtime-manifest.yaml');
  await mkdir(path.dirname(manifestPath), { recursive: true }).catch(() => undefined);
  await writeFile(manifestPath, toYaml(detected), 'utf8').catch((error) =>
    logger.warn('could not write the runtime manifest into the repository', { error }),
  );

  await context.events.append({
    projectId: context.project.id,
    taskId: context.task.id,
    eventType: 'RuntimeManifestGenerated',
    actorType: 'worker',
    actorId: context.workerId,
    payload: { manifestId: record.id, validated: validation.valid, gaps },
  });
}

export async function handleSandboxTeardown(context: JobContext, taskId: string): Promise<void> {
  const sandbox = new SandboxClient(context.project.repoPath);
  await sandbox.destroy(taskId);
  await context.events.append({
    projectId: context.project.id,
    taskId,
    eventType: 'SandboxDestroyed',
    actorType: 'worker',
    actorId: context.workerId,
    payload: {},
  });
}
