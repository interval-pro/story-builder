import { renderFinalReport, suggestCommits, validateImplementationOutcome, type ImplementationOutcome } from '@ai-engine/agents';
import { AppError } from '@ai-engine/shared';
import { carryOpenFindings } from '@ai-engine/domain';
import { changedFiles, fullDiff, GitClient } from '@ai-engine/git';
import { workspacePathFor, type JobContext } from '../job-context';

async function loadOutcome(context: JobContext): Promise<ImplementationOutcome> {
  const artifact = await context.repos.artifacts.latestByKind(context.task.id, 'implementation_outcome');
  if (!artifact) {
    return validateImplementationOutcome({ summary: 'No implementation outcome was recorded for this task.' });
  }
  return validateImplementationOutcome(JSON.parse(await context.artifacts.getText(artifact.id)));
}

/**
 * Produces the document the human reads before deciding on a pull request.
 * Planned versus actual is computed here, not narrated by the agent.
 */
export async function handleFinalReport(context: JobContext): Promise<void> {
  const approvedVersionId = await context.repos.approvals.findApprovedReviewVersionId(context.task.id);
  if (!approvedVersionId) throw new AppError('not_approved', 'The final report needs an approved review', 409);
  const approved = await context.repos.reviews.getVersion(approvedVersionId);

  const git = new GitClient(workspacePathFor(context.task.id));
  const changes = await changedFiles(git, context.task.baseCommit);
  const diff = await fullDiff(git, context.task.baseCommit);
  const outcome = await loadOutcome(context);

  const tests = await context.repos.testRuns.listByTask(context.task.id);
  const lastTest = tests[tests.length - 1] ?? null;
  const qaRuns = await context.repos.qaRuns.listByTask(context.task.id);
  const lastQa = qaRuns[qaRuns.length - 1] ?? null;

  // Resolved is everything raised that is not still open, worked out the same way
  // the fix cycle works it out. Taking "every iteration but the last" was close
  // enough while findings were replaced wholesale; now that they accumulate, a
  // finding raised in iteration one and still open in iteration three would have
  // been reported as both resolved and open in the same document.
  const runs = await context.repos.runs.listByTask(context.task.id);
  const openFindings = carryOpenFindings({
    qaRuns,
    fixTimes: runs
      .filter((run) => run.phase === 'IMPLEMENTATION' && run.finishedAt)
      .map((run) => run.finishedAt as string),
  });
  const stillOpen = new Set(openFindings.map((finding) => `${finding.file ?? ''}::${finding.summary}`));
  const resolvedFindings = qaRuns
    .flatMap((run) => run.findings)
    .filter((finding) => !stillOpen.has(`${finding.file ?? ''}::${finding.summary}`))
    .map((finding) => ({ ...finding, status: 'RESOLVED' as const }));

  const remainingRisks = [
    ...approved.document.riskSignals.map((signal) => `${signal.indicator}: ${signal.evidence}`),
    ...(lastQa?.verdict === 'APPROVED' ? [] : ['QA has not approved this change.']),
    ...(lastTest && !lastTest.passed ? ['The last recorded test run did not pass.'] : []),
  ];

  const report = renderFinalReport({
    storyTitle: context.story.title,
    storyBody: context.revision.body,
    approvedReview: approved.document,
    outcome,
    changes,
    buildResult: null,
    testResult: lastTest ? { command: lastTest.command, exitCode: lastTest.exitCode } : null,
    qaFindings: lastQa?.verdict === 'APPROVED' ? [] : openFindings,
    resolvedFindings,
    qaIterations: qaRuns.length,
    migrationResult: null,
    remainingRisks,
    diff,
    suggestedCommits: suggestCommits(approved.document, outcome),
    baseCommit: context.task.baseCommit,
    branchName: context.task.branchName,
  });

  const artifact = await context.artifacts.put({
    projectId: context.project.id,
    taskId: context.task.id,
    kind: 'final_report',
    contentType: 'text/markdown',
    content: report,
  });

  await context.events.append({
    projectId: context.project.id,
    taskId: context.task.id,
    eventType: 'FinalReviewGenerated',
    actorType: 'worker',
    actorId: context.workerId,
    payload: { artifactId: artifact.id, changedFiles: changes.length },
  });

  await context.orchestrator.checkpoint({
    taskId: context.task.id,
    gitHead: await git.headCommit().catch(() => null),
    workspaceMetadata: { finalReportArtifactId: artifact.id },
  });

  // Learning runs regardless of whether the change is ever pushed.
  await context.repos.metrics.record({
    projectId: context.project.id,
    taskId: context.task.id,
    name: 'qa_iterations',
    value: qaRuns.length,
  });
}
