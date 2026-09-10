import { AppError, loadConfig } from '@ai-engine/shared';
import { classifyTaskSize } from '@ai-engine/domain';
import { loadAgentPrompt, runQaAgent } from '@ai-engine/agents';
import { fullDiff, GitClient } from '@ai-engine/git';
import {
  buildProjectContext,
  createAgentRunner,
  createExecutor,
  ensureDependencies,
  recordEngineMetrics,
  resolveAgentVersion,
  workspacePathFor,
  type JobContext,
} from '../job-context';
import { SandboxClient } from '../sandbox-client';

/** Runs the project test suite and records the result against the task. */
async function runProjectTests(context: JobContext, runId: string): Promise<{ command: string; exitCode: number; output: string }[]> {
  const manifest = await context.repos.runtimeManifests.latest(context.project.id);
  const commands = manifest?.manifest.test.commands ?? [];
  if (commands.length === 0) {
    return [{ command: '(no test command in the runtime manifest)', exitCode: 0, output: 'No test command is configured for this project.' }];
  }

  await ensureDependencies(context);
  const executor = createExecutor(context.task.id);
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
      cwd: workspacePathFor(context.task.id),
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
  const sandbox = new SandboxClient(context.project.repoPath);
  await sandbox.setMode(context.task.id, 'READ_ONLY');

  await context.orchestrator.ensureState({
    taskId: context.task.id,
    to: 'QA_RUNNING',
    actor: { type: 'worker', id: context.workerId },
  });

  const approvedVersionId = await context.repos.approvals.findApprovedReviewVersionId(context.task.id);
  if (!approvedVersionId) throw new AppError('not_approved', 'QA needs an approved review to compare against', 409);
  const approved = await context.repos.reviews.getVersion(approvedVersionId);

  const iteration = context.task.qaIteration + 1;
  const prompt = await loadAgentPrompt('qa', context.installRoot);
  const agentVersionId = await resolveAgentVersion(context, 'qa', prompt);
  const run = await context.repos.runs.start({
    taskId: context.task.id,
    phase: 'QA',
    agentType: 'qa',
    agentVersionId,
  });

  try {
    const testResults = await runProjectTests(context, run.id);
    const git = new GitClient(workspacePathFor(context.task.id));
    const diff = await fullDiff(git, context.task.baseCommit);

    // QA gets a fresh session on purpose: it must not see the implementation's reasoning.
    const size = classifyTaskSize({
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
    await context.repos.runs.complete(run.id, outcome.usage);
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

    if (iteration >= config.service.maxQaIterations) {
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
    await context.repos.runs.fail(run.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
