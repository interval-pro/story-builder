import { HttpRouter, ValidationError } from '@ai-engine/shared';
import { SETTING_KEYS } from '@ai-engine/domain';
import { actorFrom, requireBody, type ApiContext } from '../context';

/**
 * The single queue, shared by every project.
 *
 * Two lists, because there are two different things and conflating them is what
 * made the old status page unreadable: work the machine will do, and work that
 * cannot move until a person acts. No amount of concurrency clears the second
 * list, and nothing in the first list is waiting on anybody.
 */
export function registerQueueRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/queue', async () => {
    const [entries, waitingTasks, policy, runningSlots, openDecisions] = await Promise.all([
      context.queue.overview(),
      context.repos.tasks.listWaitingForHuman(),
      context.repos.settings.queuePolicy(),
      context.queue.runningSlots(),
      context.repos.reviewDecisions.openBlockingByTask(),
    ]);

    return {
      entries,
      waiting: waitingTasks.map((task) => ({
        taskId: task.id,
        projectId: task.projectId,
        projectName: task.projectName,
        storyTitle: task.storyTitle,
        state: task.state,
        since: task.updatedAt,
        openDecisions: openDecisions.get(task.id) ?? 0,
        blockedReason: task.blockedReason,
      })),
      policy: { ...policy, runningSlots },
      running: entries.filter((entry) => entry.status === 'RUNNING').length,
      pending: entries.filter((entry) => entry.status === 'PENDING').length,
    };
  });

  router.post('/api/queue/pause', async () => {
    await context.repos.settings.set(SETTING_KEYS.queuePaused, 'true');
    return { paused: true };
  });

  router.post('/api/queue/resume', async () => {
    await context.repos.settings.set(SETTING_KEYS.queuePaused, 'false');
    return { paused: false };
  });

  /**
   * Rewrites the order. Expects the full ordered list of pending ids, which is
   * what the cockpit has after a drag; sending a subset would leave the rest of
   * the queue interleaved in a way nobody asked for.
   */
  router.post('/api/queue/reorder', async ({ body }) => {
    const input = requireBody<{ ids: string[] }>(body, ['ids']);
    if (!Array.isArray(input.ids) || input.ids.some((id) => typeof id !== 'string')) {
      throw new ValidationError('ids must be a list of queue entry ids');
    }
    return { reordered: await context.queue.reorder(input.ids) };
  });

  router.post('/api/queue/:id/hold', async ({ params }) => {
    const held = await context.queue.hold(params['id']!);
    if (!held) throw new ValidationError('Only a waiting entry can be held. This one is already running or finished.');
    return { held: true };
  });

  router.post('/api/queue/:id/release', async ({ params }) => {
    return { released: await context.queue.release(params['id']!) };
  });

  /**
   * Cancels one waiting entry.
   *
   * A running entry is left alone: its worker owns the lease, and cancelling the
   * row would strand it. Stopping running work is what the task's own Stop is
   * for, because it also has to move the task's state.
   */
  router.post('/api/queue/:id/cancel', async ({ params, headers }) => {
    const job = await context.queue.getById(params['id']!);
    const cancelled = await context.queue.cancel(job.id);
    if (!cancelled) {
      throw new ValidationError(
        job.status === 'RUNNING'
          ? 'This entry is running. Stop the story instead, which also moves it out of the step it is in.'
          : `This entry is already ${job.status.toLowerCase()}.`,
      );
    }
    if (job.taskId) {
      await context.events.append({
        projectId: (await context.repos.tasks.getById(job.taskId)).projectId,
        taskId: job.taskId,
        eventType: 'TaskStopped',
        actorType: actorFrom(headers as Record<string, unknown>).type,
        actorId: actorFrom(headers as Record<string, unknown>).id,
        payload: { cancelledJob: job.id, jobType: job.jobType },
      });
    }
    return { cancelled: true };
  });
}
