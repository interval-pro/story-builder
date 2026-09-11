import { HttpRouter, ValidationError } from '@ai-engine/shared';
import { SETTING_KEYS } from '@ai-engine/domain';
import { requireBody, resolveProjectId, type ApiContext } from '../context';

/**
 * Chat with the engine, in a project.
 *
 * This is the one place the engine is driven turn by turn by a person rather than
 * by the pipeline, and it is deliberately the widest: the window exists to be the
 * terminal they would otherwise open in the project directory.
 *
 * A turn runs as a queue job so the API never holds a request open for minutes,
 * and the job does not consume an agent slot: a person waiting at a keyboard must
 * not queue behind a fix cycle.
 */
export function registerChatRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/chat/sessions', async ({ query }) => {
    const projectId = await resolveProjectId(context, query.get('projectId'));
    return { sessions: await context.repos.chat.listSessions(projectId) };
  });

  router.post('/api/chat/sessions', async ({ body }) => {
    const input = (body ?? {}) as { projectId?: string; title?: string; permissionMode?: string };
    const projectId = await resolveProjectId(context, input.projectId ?? null);
    const permissionMode =
      input.permissionMode ?? (await context.repos.settings.forProject(projectId).text(SETTING_KEYS.chatPermissionMode));
    return {
      session: await context.repos.chat.createSession({
        projectId,
        ...(input.title ? { title: input.title } : {}),
        permissionMode,
      }),
    };
  });

  router.get('/api/chat/sessions/:id', async ({ params }) => {
    const session = await context.repos.chat.getSession(params['id']!);
    return {
      session,
      project: await context.repos.projects.getById(session.projectId),
      messages: await context.repos.chat.listMessages(session.id),
      pending: await context.repos.chat.hasPendingTurn(session.id),
    };
  });

  router.put('/api/chat/sessions/:id', async ({ params, body }) => {
    const input = (body ?? {}) as { title?: string; permissionMode?: string };
    return { session: await context.repos.chat.updateSession(params['id']!, input) };
  });

  router.delete('/api/chat/sessions/:id', async ({ params }) => {
    await context.repos.chat.archiveSession(params['id']!);
    return { archived: params['id'] };
  });

  /**
   * Sends a turn.
   *
   * Two turns at once would both resume the same engine session and interleave,
   * so one at a time per session. The assistant row is created empty and filled
   * in as the answer streams, which is what makes a long answer readable while it
   * is still being written.
   */
  router.post('/api/chat/sessions/:id/messages', async ({ params, body }) => {
    const input = requireBody<{ text: string }>(body, ['text']);
    const session = await context.repos.chat.getSession(params['id']!);
    if (await context.repos.chat.hasPendingTurn(session.id)) {
      throw new ValidationError('This chat is still answering. Wait for it to finish before sending the next message.');
    }

    const prompt = input.text.trim();
    if (!prompt) throw new ValidationError('A message needs some text');

    await context.repos.chat.appendMessage({ sessionId: session.id, role: 'user', content: prompt });
    const answer = await context.repos.chat.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      status: 'PENDING',
    });

    const job = await context.queue.enqueue({
      taskId: null,
      projectId: session.projectId,
      jobType: 'CHAT_TURN',
      payload: { projectId: session.projectId, sessionId: session.id, messageId: answer.id, prompt },
      // One attempt. A chat turn that failed is visible in the transcript, and
      // retrying it silently would send the same message to the engine twice.
      maxAttempts: 1,
    });
    if (!job) {
      // Nothing was queued, so nothing will ever answer this row. Saying so here
      // is better than leaving a message that sits at "thinking" forever.
      await context.repos.chat.updateMessage(answer.id, {
        status: 'FAILED',
        error: 'The turn could not be queued.',
      });
      throw new ValidationError('The turn could not be queued. Try again.');
    }

    return { messageId: answer.id };
  });
}
