import { renderFinalReport, suggestCommits, validateImplementationOutcome, type ImplementationOutcome } from '@ai-engine/agents';
import { AppError } from '@ai-engine/shared';
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
  const resolvedFindings = qaRuns
    .slice(0, -1)
    .flatMap((run) => run.findings)
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
    qaFindings: lastQa?.verdict === 'APPROVED' ? [] : (lastQa?.findings ?? []),
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
