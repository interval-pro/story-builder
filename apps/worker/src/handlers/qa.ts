import { AppError, loadConfig } from '@ai-engine/shared';
import { SETTING_KEYS, carryOpenFindings, classifyTaskSize } from '@ai-engine/domain';
import { loadAgentPrompt, runQaAgent } from '@ai-engine/agents';
import { fullDiff, GitClient } from '@ai-engine/git';
import { takeDirectory } from '../project-directory';
import {
  buildProjectContext,
  createAgentRunner,
  createExecutor,
  failRun,
  recordEngineMetrics,
  recordSessionStart,
  resolveAgentVersion,
  resumableSessionFor,
  runCompletion,
  type JobContext,
} from '../job-context';

/** Runs the project test suite and records the result against the task. */
async function runProjectTests(context: JobContext, runId: string): Promise<{ command: string; exitCode: number; output: string }[]> {
  const manifest = await context.repos.runtimeManifests.latest(context.project.id);
  const commands = manifest?.manifest.test.commands ?? [];
  if (commands.length === 0) {
    return [{ command: '(no test command in the runtime manifest)', exitCode: 0, output: 'No test command is configured for this project.' }];
  }

  // No dependency install: this is the directory its owner works in, so whatever
  // the tests need is already there. Installing into someone's checkout because a
  // story is running would be a change nobody asked for.
  const executor = createExecutor(context.project.repoPath);
  const results: { command: string; exitCode: number; output: string }[] = [];

  for (const command of commands) {
    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      runId,
      eventType: 'TestStarted',
      actorType: 'worker',
      actorId: context.workerId,
      payload: { command },
    });

    const outcome = await executor.run({
      command,
      cwd: context.project.repoPath,
      timeoutMs: loadConfig().sandbox.commandTimeoutMs,
      readOnly: true,
    });
    const output = `${outcome.stdout}\n${outcome.stderr}`.trim();
    const artifact = await context.artifacts.put({
      projectId: context.project.id,
      taskId: context.task.id,
      runId,
      kind: 'test_log',
      content: `$ ${command}\nexit code: ${outcome.exitCode}\n\n${output}`,
      metadata: { command, exitCode: outcome.exitCode },
    });
    await context.repos.testRuns.record({
      taskId: context.task.id,
      runId,
      command,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      logArtifactId: artifact.id,
    });
    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      runId,
      eventType: outcome.exitCode === 0 ? 'TestPassed' : 'TestFailed',
      actorType: 'worker',
      actorId: context.workerId,
      payload: { command, exitCode: outcome.exitCode },
    });
    results.push({ command, exitCode: outcome.exitCode, output });
  }

  return results;
}

/**
 * Independent QA. The fix loop is bounded; after the configured number of
 * iterations the task is blocked for a human instead of looping forever.
 */
export async function handleQa(context: JobContext): Promise<void> {
  const config = loadConfig();
  await takeDirectory(context);

  await context.orchestrator.ensureState({
    taskId: context.task.id,
    to: 'QA_RUNNING',
    actor: { type: 'worker', id: context.workerId },
  });

  const approvedVersionId = await context.repos.approvals.findApprovedReviewVersionId(context.task.id);
  if (!approvedVersionId) throw new AppError('not_approved', 'QA needs an approved review to compare against', 409);
  const approved = await context.repos.reviews.getVersion(approvedVersionId);

  const iteration = context.task.qaIteration + 1;

  // What earlier iterations raised and nobody has resolved. Each iteration runs
  // in a fresh context that sees only the diff, so it cannot know what the last
  // one found unless it is told, and a finding that quietly disappears between
  // iterations is how a verified defect leaves the record.
  const previousQaRuns = await context.repos.qaRuns.listByTask(context.task.id);
  const implementationRuns = await context.repos.runs.listByTask(context.task.id);
  const carriedFindings = carryOpenFindings({
    qaRuns: previousQaRuns,
    fixTimes: implementationRuns
      .filter((run) => run.phase === 'IMPLEMENTATION' && run.finishedAt)
      .map((run) => run.finishedAt as string),
  });
  const prompt = await loadAgentPrompt('qa', context.installRoot);
  const agentVersionId = await resolveAgentVersion(context, 'qa', prompt);
  // QA never sees the implementation's session: it must judge the code without
  // the reasoning behind it. The only session it will continue is one of its
  // own, left behind by a QA attempt that failed a moment ago.
  const previousSessionId = await resumableSessionFor(context, 'QA');

  const run = await context.repos.runs.start({
    taskId: context.task.id,
    projectId: context.project.id,
    phase: 'QA',
    agentType: 'qa',
    agentVersionId,
    sessionId: previousSessionId,
    ...(previousSessionId ? { resumed: true } : {}),
  });

  try {
    const testResults = await runProjectTests(context, run.id);
    const git = new GitClient(context.project.repoPath);
    const diff = await fullDiff(git, context.task.baseCommit);

    // Classified once by the review and held since; a task from before that was
    // recorded has none, so it is worked out here instead.
    const size =
      context.task.size ??
      classifyTaskSize({
        fileCount: approved.document.expectedFiles.length,
        riskSignalCount: approved.document.riskSignals.length,
      });
    const runner = await createAgentRunner({ context, runId: run.id, phase: 'QA', allowWeb: false, size });

    const { report, outcome } = await runQaAgent({
      runner,
      projectContext: await buildProjectContext(context),
      story: context.story,
      revision: context.revision,
      task: context.task,
      approvedReview: approved.document,
      diff,
      testResults,
      iteration,
      installRoot: context.installRoot,
      ...(carriedFindings.length > 0 ? { carriedFindings } : {}),
      onSessionStart: recordSessionStart(context, run.id, Boolean(previousSessionId)),
      ...(previousSessionId ? { resumeSessionId: previousSessionId } : {}),
    });

    const testsFailed = testResults.some((result) => result.exitCode !== 0);
    const verdict = testsFailed && report.verdict === 'APPROVED' ? 'REJECTED' : report.verdict;
    const findings = testsFailed
      ? [
          ...report.findings,
          {
            id: 'tests-failing',
            category: 'tests' as const,
            severity: 'blocking' as const,
            file: null,
            summary: 'The project test suite does not pass on this change.',
            detail: testResults
              .filter((result) => result.exitCode !== 0)
              .map((result) => `${result.command} exited ${result.exitCode}`)
              .join('; '),
            suggestedFix: 'Fix the failing tests before this change can be reviewed for merge.',
            status: 'OPEN' as const,
          },
        ]
      : report.findings;

    await context.repos.qaRuns.record({
      taskId: context.task.id,
      runId: run.id,
      iteration,
      verdict,
      findings,
      // Recorded even when the verdict is APPROVED: a remark made about a change
      // that passed is the one most likely to be useful later and the one most
      // likely to be lost.
      notes: report.notes,
    });
    await context.artifacts.put({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: run.id,
      kind: 'qa_report',
      contentType: 'text/markdown',
      content: [
        `# QA report (iteration ${iteration})`,
        '',
        `Verdict: ${verdict}`,
        '',
        report.summary,
        '',
        ...findings.map(
          (finding) =>
            `## [${finding.severity}/${finding.category}] ${finding.summary}\n\n${finding.detail}\n\nSuggested fix: ${finding.suggestedFix}`,
        ),
        ...(report.notes.length > 0
          ? ['', '# Notes', '', ...report.notes.map((note) => `- ${note.summary}${note.file ? ` (${note.file})` : ''}`)]
          : []),
      ].join('\n'),
    });
    await context.artifacts.put({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: run.id,
      kind: 'qa_transcript',
      contentType: 'text/markdown',
      content: outcome.transcript,
    });
    await context.repos.runs.complete(run.id, runCompletion(outcome));
    await recordEngineMetrics(context, 'qa', outcome);
    await context.repos.tasks.update(context.task.id, { qaIteration: iteration });

    await context.events.append({
      projectId: context.project.id,
      taskId: context.task.id,
      runId: run.id,
      eventType: verdict === 'APPROVED' ? 'QAApproved' : 'QARejected',
      actorType: 'agent',
      actorId: 'qa',
      payload: { iteration, findings: findings.length, verdict },
    });

    if (verdict === 'APPROVED') {
      await context.orchestrator.transition({
        taskId: context.task.id,
        to: 'FINAL_REVIEW_READY',
        actor: { type: 'agent', id: 'qa' },
        enqueue: { jobType: 'FINAL_REPORT' },
      });
      return;
    }

    if (verdict === 'BLOCKED' || report.requiresSupplementalReview) {
      await context.orchestrator.block(
        context.task.id,
        report.supplementalReason || 'QA found a problem that requires a change of scope',
        { type: 'agent', id: 'qa' },
      );
      return;
    }

    // The configured limit, not the environment's: the Checks tab draws the
    // remaining cycles from the setting, and enforcing a different number here
    // is how it comes to say two are left when none are.
    const maxIterations = await context.settings.integer(SETTING_KEYS.maxQaIterations);
    if (iteration >= maxIterations) {
      await context.orchestrator.block(
        context.task.id,
        `QA still rejects this change after ${iteration} fix iterations. A human decision is required.`,
        { type: 'agent', id: 'qa' },
      );
      return;
    }

    // The fix job moves the task into FIXING itself, so only one transition here.
    await context.orchestrator.transition({
      taskId: context.task.id,
      to: 'FIX_REQUIRED',
      actor: { type: 'agent', id: 'qa' },
      payload: { iteration, findings: findings.length },
      enqueue: { jobType: 'FIX', payload: { iteration } },
    });
  } catch (error) {
    await failRun(context, run.id, error);
    throw error;
  }
}
