import { HttpRouter, ValidationError } from '@ai-engine/shared';
import { actorFrom, requireBody, resolveProjectId, type ApiContext } from '../context';

/**
 * Building a story before running it.
 *
 * The step exists because of two failures that are expensive later: an idea that
 * is really four stories becomes one review nobody can approve as a whole, and an
 * idea described too thinly makes the research pass guess what it meant.
 */
export function registerIdeaRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/ideas', async ({ query }) => {
    const projectId = await resolveProjectId(context, query.get('projectId'));
    return { sessions: await context.repos.ideas.listByProject(projectId) };
  });

  router.post('/api/ideas', async ({ body }) => {
    const input = requireBody<{ idea: string; projectId?: string }>(body, ['idea']);
    if (input.idea.trim().length < 10) {
      throw new ValidationError('Describe the idea in at least a sentence.');
    }
    const projectId = await resolveProjectId(context, input.projectId ?? null);
    const project = await context.repos.projects.getById(projectId);
    if (project.setupState !== 'READY') {
      throw new ValidationError(`${project.name} is still being prepared, so it cannot be read yet.`);
    }
    return context.commands.startIdea({ projectId, idea: input.idea.trim() });
  });

  router.get('/api/ideas/:id', async ({ params }) => {
    const session = await context.repos.ideas.getById(params['id']!);
    const questions = await context.repos.ideas.listQuestions(session.id);
    return {
      session,
      // Only the newest round is answerable. Earlier rounds are history, and
      // showing them as open would invite answering a question twice.
      currentRound: questions.filter((question) => question.round === session.round),
      history: questions.filter((question) => question.round < session.round),
      drafts: await context.repos.ideas.listDraftsForSession(session.id),
      runs: await context.repos.runs.listBySubject(session.id),
    };
  });

  /**
   * Answers one question. The next round is only asked once every question in
   * this one is answered, because a run spent on a half-answered round would ask
   * again about something the person was still deciding.
   */
  router.post('/api/ideas/:id/answers', async ({ params, body }) => {
    const input = requireBody<{ questionId: string; chosenKey: string; customAnswer?: string }>(body, [
      'questionId',
      'chosenKey',
    ]);
    return context.commands.answerIdeaQuestion({
      sessionId: params['id']!,
      questionId: input.questionId,
      chosenKey: input.chosenKey,
      ...(input.customAnswer ? { customAnswer: input.customAnswer } : {}),
    });
  });

  router.delete('/api/ideas/:id', async ({ params }) => {
    await context.repos.ideas.discard(params['id']!);
    return { discarded: params['id'] };
  });

  router.get('/api/drafts', async ({ query }) => {
    const projectId = await resolveProjectId(context, query.get('projectId'));
    return { drafts: await context.repos.ideas.listDrafts(projectId) };
  });

  /** A story written by hand, for when the idea needs no conversation at all. */
  router.post('/api/drafts', async ({ body }) => {
    const input = requireBody<{ title: string; body: string; projectId?: string }>(body, ['title', 'body']);
    const projectId = await resolveProjectId(context, input.projectId ?? null);
    return { draft: await context.repos.ideas.createDraft({ projectId, title: input.title, body: input.body }) };
  });

  router.put('/api/drafts/:id', async ({ params, body }) => {
    const input = (body ?? {}) as { title?: string; body?: string };
    if (input.body !== undefined && input.body.trim().length < 10) {
      throw new ValidationError('A story needs at least a sentence of description.');
    }
    return { draft: await context.repos.ideas.updateDraft(params['id']!, input) };
  });

  router.delete('/api/drafts/:id', async ({ params }) => {
    await context.repos.ideas.discardDraft(params['id']!);
    return { discarded: params['id'] };
  });

  /** The one moment a draft stops being editable text and becomes work. */
  router.post('/api/drafts/:id/launch', async ({ params, headers }) => {
    return context.commands.launchDraft({
      draftId: params['id']!,
      actor: actorFrom(headers as Record<string, unknown>),
    });
  });
}
