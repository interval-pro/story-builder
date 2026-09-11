import { HttpRouter, ValidationError } from '@ai-engine/shared';
import { requireBody, type ApiContext } from '../context';

/**
 * The settings a person may change while the system runs.
 *
 * The screen is generated from the descriptors rather than written twice, so a
 * new setting is one entry in the domain list and appears here with its own
 * explanation. Secrets travel one way only: in, never out.
 */
export function registerSettingsRoutes(router: HttpRouter, context: ApiContext): void {
  router.get('/api/settings', async () => {
    return { settings: await context.repos.settings.describe() };
  });

  router.put('/api/settings', async ({ body }) => {
    const input = requireBody<{ values: Record<string, string> }>(body, ['values']);
    if (typeof input.values !== 'object' || input.values === null) {
      throw new ValidationError('values must be an object of setting keys');
    }
    for (const [key, value] of Object.entries(input.values)) {
      if (typeof value !== 'string') throw new ValidationError(`The value for "${key}" must be text`);
      await context.repos.settings.set(key, value);
    }
    return { settings: await context.repos.settings.describe() };
  });

  /** Removes an override, so the value falls back to the environment or default. */
  router.delete('/api/settings/:key', async ({ params }) => {
    await context.repos.settings.clear(params['key']!);
    return { settings: await context.repos.settings.describe() };
  });
}
