import { validateResearchFindings, type ResearchFindings } from '@ai-engine/agents';
import { AppError } from '@ai-engine/shared';
import { buildProjectContext, type JobContext } from '../job-context';
import { generateReview } from './research';

/** Falls back to an empty findings object if the research artifact is missing. */
async function loadFindings(context: JobContext): Promise<ResearchFindings> {
  const artifact = await context.repos.artifacts.latestByKind(context.task.id, 'research_findings_json');
  if (!artifact) {
    return validateResearchFindings({ summary: 'The original research findings are no longer available.' });
  }
  const raw = await context.artifacts.getText(artifact.id);
  return validateResearchFindings(JSON.parse(raw));
}

/**
 * Regenerates the review from the human notes. The notes are corrections, so
 * the previous review and its notes are both fed back into the agent.
 */
export async function handleReviewRegenerate(context: JobContext): Promise<void> {
  const review = await context.repos.reviews.findCurrentForTask(context.task.id);
  if (!review) throw new AppError('no_review', 'This task has no review to regenerate', 409);

  const previousVersion = await context.repos.reviews.getLatestVersion(review.id);
  if (!previousVersion) throw new AppError('no_review_version', 'This review has no versions yet', 409);

  const notes = await context.repos.reviews.listOpenNotes(review.id);
  const projectContext = await buildProjectContext(context);
  const findings = await loadFindings(context);

  await generateReview(context, {
    projectContext,
    findings,
    previousReview: { document: previousVersion.document, notes },
  });
}

/** Used when a review must be produced without re-running research. */
export async function handleReviewGenerate(context: JobContext): Promise<void> {
  const projectContext = await buildProjectContext(context);
  const findings = await loadFindings(context);
  await generateReview(context, { projectContext, findings, previousReview: null });
}
