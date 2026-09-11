import { HttpRouter, ValidationError } from '@ai-engine/shared';
import { actorFrom, resolveProjectId, requireBody, type ApiContext } from '../context';

/** Story creation and story revisions. A story is free text in v0. */
export function registerStoryRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/stories', async ({ query }) => {
    const projectId = await resolveProjectId(context, query.get('projectId'));
    const stories = await context.repos.stories.listByProject(projectId);
    const withTasks = await Promise.all(
      stories.map(async (story) => {
        const tasks = await context.repos.tasks.findByStory(story.id);
        return { ...story, tasks };
      }),
    );
    return { stories: withTasks };
  });

  router.post('/api/stories', async ({ body, headers }) => {
    const input = requireBody<{ body: string; title?: string; projectId?: string; startAnalysis?: boolean }>(
      body,
      ['body'],
    );
    if (input.body.trim().length < 10) {
      throw new ValidationError('A story needs at least a sentence of description');
    }
    const projectId = await resolveProjectId(context, input.projectId ?? null);
    const result = await context.commands.createStory({
      projectId,
      body: input.body,
      ...(input.title ? { title: input.title } : {}),
      actor: actorFrom(headers as Record<string, unknown>),
      startAnalysis: input.startAnalysis ?? true,
    });
    return result;
  });

  router.get('/api/stories/:id', async ({ params }) => {
    const story = await context.repos.stories.getById(params['id']!);
    const revisions = await context.repos.stories.listRevisions(story.id);
    const tasks = await context.repos.tasks.findByStory(story.id);
    return { story, revisions, tasks };
  });

  router.post('/api/stories/:id/revisions', async ({ params, body, headers }) => {
    const input = requireBody<{ body: string }>(body, ['body']);
    const tasks = await context.repos.tasks.findByStory(params['id']!);
    const task = tasks[0];
    if (!task) throw new ValidationError('This story has no task');
    return context.commands.reviseStory({
      taskId: task.id,
      body: input.body,
      actor: actorFrom(headers as Record<string, unknown>),
    });
  });
}
