import type { QaFinding, ReviewDocument } from '@ai-engine/domain';
import { renderReviewMarkdown } from '@ai-engine/domain';
import type { FileChange } from '@ai-engine/git';
import { summarizeChanges } from '@ai-engine/git';
import type { ImplementationOutcome } from '../schemas';

export interface FinalReportInput {
  storyTitle: string;
  storyBody: string;
  approvedReview: ReviewDocument;
  outcome: ImplementationOutcome;
  changes: FileChange[];
  buildResult: { command: string; exitCode: number } | null;
  testResult: { command: string; exitCode: number } | null;
  qaFindings: QaFinding[];
  resolvedFindings: QaFinding[];
  qaIterations: number;
  migrationResult: string | null;
  remainingRisks: string[];
  diff: string;
  suggestedCommits: string[];
  baseCommit: string;
  branchName: string;
}

function list(entries: string[], empty = '(none)'): string {
  return entries.length > 0 ? entries.map((entry) => `- ${entry}`).join('\n') : empty;
}

function findingLines(findings: QaFinding[]): string {
  if (findings.length === 0) return '(none)';
  return findings
    .map((finding) => `- [${finding.severity}/${finding.category}] ${finding.summary}${finding.file ? ` (${finding.file})` : ''}`)
    .join('\n');
}

/**
 * The document the human reads before deciding whether this becomes a pull
 * request. It exists to make planned versus actual impossible to hide.
 */
export function renderFinalReport(input: FinalReportInput): string {
  const plannedFiles = input.approvedReview.expectedFiles;
  const actualFiles = input.changes.map((change) => change.filePath);
  const unplanned = actualFiles.filter((file) => !plannedFiles.includes(file));
  const missing = plannedFiles.filter((file) => !actualFiles.includes(file));

  return [
    `# Final Implementation Report`,
    '',
    `## Summary`,
    '',
    input.outcome.summary || '(the implementation agent produced no summary)',
    '',
    `Branch: ${input.branchName}`,
    `Base commit: ${input.baseCommit}`,
    '',
    '## Story',
    '',
    `**${input.storyTitle}**`,
    '',
    input.storyBody,
    '',
    '## Approved plan',
    '',
    renderReviewMarkdown(input.approvedReview),
    '',
    '## Planned versus actual',
    '',
    `Planned files (${plannedFiles.length}):`,
    list(plannedFiles),
    '',
    `Actual files (${actualFiles.length}):`,
    list(actualFiles),
    '',
    `Files changed but not planned (${unplanned.length}):`,
    list(unplanned),
    '',
    `Files planned but not changed (${missing.length}):`,
    list(missing),
    '',
    '## Reason for deviations',
    '',
    input.outcome.deviations.length > 0
      ? input.outcome.deviations
          .map((deviation) => `- planned: ${deviation.planned}\n  actual: ${deviation.actual}\n  reason: ${deviation.reason}`)
          .join('\n')
      : '(no deviations were reported)',
    '',
    '## Changed files',
    '',
    summarizeChanges(input.changes),
    '',
    input.changes
      .map((change) => `- ${change.changeType.padEnd(9)} +${change.insertions} -${change.deletions}  ${change.filePath}`)
      .join('\n') || '(none)',
    '',
    '## Changed symbols',
    '',
    list(input.approvedReview.expectedSymbols),
    '',
    '## Tests',
    '',
    `Added:\n${list(input.outcome.testsAdded)}`,
    '',
    `Modified:\n${list(input.outcome.testsModified)}`,
    '',
    `Removed:\n${list(input.outcome.testsRemoved)}`,
    '',
    `Why existing tests changed: ${input.outcome.testJustification || '(no existing test was changed)'}`,
    '',
    '## Verification',
    '',
    `Build: ${input.buildResult ? `${input.buildResult.command} exited ${input.buildResult.exitCode}` : 'not run'}`,
    `Tests: ${input.testResult ? `${input.testResult.command} exited ${input.testResult.exitCode}` : 'not run'}`,
    `Migrations: ${input.migrationResult ?? 'none'}`,
    '',
    '## QA',
    '',
    `Iterations: ${input.qaIterations}`,
    '',
    `Resolved findings:\n${findingLines(input.resolvedFindings)}`,
    '',
    `Open findings:\n${findingLines(input.qaFindings)}`,
    '',
    '## Remaining risks',
    '',
    list(input.remainingRisks),
    '',
    '## Suggested commits',
    '',
    list(input.suggestedCommits),
    '',
    '## Git diff',
    '',
    '```diff',
    input.diff.slice(0, 400_000),
    '```',
    '',
  ].join('\n');
}

/** Derives commit subjects from the review plan when the agent proposed none. */
export function suggestCommits(review: ReviewDocument, outcome: ImplementationOutcome): string[] {
  if (review.implementationSteps.length === 0) {
    return [outcome.summary.split('\n')[0]?.slice(0, 72) || 'Implement approved change'];
  }
  return review.implementationSteps
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((step) => step.title.slice(0, 72));
}
