import { HttpRouter, ValidationError } from '@ai-engine/shared';
import { diffReviewDocuments } from '@ai-engine/domain';
import { actorFrom, requireBody, type ApiContext } from '../context';

/** The engineering review, its versions, the human notes and the approvals. */
export function registerReviewRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/tasks/:id/review', async ({ params }) => {
    const review = await context.repos.reviews.findCurrentForTask(params['id']!);
    if (!review) return { review: null, versions: [], notes: [], diff: [] };
    const versions = await context.repos.reviews.listVersions(review.id);
    const notes = await context.repos.reviews.listNotes(review.id);
    const current = versions[versions.length - 1];
    const previous = versions[versions.length - 2];
    const diff = current && previous ? diffReviewDocuments(previous.document, current.document) : [];
    return { review, versions, notes, diff, current: current ?? null };
  });

  router.get('/api/tasks/:id/reviews', async ({ params }) => {
    const reviews = await context.repos.reviews.listByTask(params['id']!);
    const detailed = await Promise.all(
      reviews.map(async (review) => ({
        review,
        versions: await context.repos.reviews.listVersions(review.id),
        notes: await context.repos.reviews.listNotes(review.id),
      })),
    );
    return { reviews: detailed };
  });

  router.post('/api/tasks/:id/review/notes', async ({ params, body, headers }) => {
    const input = requireBody<{
      reviewId: string;
      reviewVersionId: string;
      anchorText: string;
      note: string;
      sectionKey?: string;
      anchorStart?: number;
      anchorEnd?: number;
    }>(body, ['reviewId', 'reviewVersionId', 'anchorText', 'note']);

    return context.commands.addReviewNote({
      taskId: params['id']!,
      reviewId: input.reviewId,
      reviewVersionId: input.reviewVersionId,
      sectionKey: input.sectionKey ?? null,
      anchorText: input.anchorText,
      anchorStart: input.anchorStart ?? null,
      anchorEnd: input.anchorEnd ?? null,
      note: input.note,
      actor: actorFrom(headers as Record<string, unknown>),
    });
  });

  router.post('/api/tasks/:id/review/regenerate', async ({ params, headers }) => {
    return { task: await context.commands.regenerateReview({ taskId: params['id']!, actor: actorFrom(headers as Record<string, unknown>) }) };
  });

  router.post('/api/tasks/:id/review/approve', async ({ params, body, headers }) => {
    const input = (body ?? {}) as { comment?: string };
    return {
      task: await context.commands.approveReview({
        taskId: params['id']!,
        ...(input.comment ? { comment: input.comment } : {}),
        actor: actorFrom(headers as Record<string, unknown>),
      }),
    };
  });

  router.post('/api/tasks/:id/high-risk/confirm', async ({ params, body, headers }) => {
    const input = (body ?? {}) as { comment?: string };
    return {
      task: await context.commands.confirmHighRisk({
        taskId: params['id']!,
        ...(input.comment ? { comment: input.comment } : {}),
        actor: actorFrom(headers as Record<string, unknown>),
      }),
    };
  });

  router.post('/api/tasks/:id/pull-request/approve', async ({ params, body, headers }) => {
    const input = (body ?? {}) as { comment?: string };
    const task = await context.repos.tasks.getById(params['id']!);
    if (task.state !== 'FINAL_REVIEW_READY') {
      throw new ValidationError(`A pull request can only be approved from FINAL_REVIEW_READY, not ${task.state}`);
    }
    return {
      task: await context.commands.approvePullRequest({
        taskId: task.id,
        ...(input.comment ? { comment: input.comment } : {}),
        actor: actorFrom(headers as Record<string, unknown>),
      }),
    };
  });
}
