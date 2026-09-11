import { HttpRouter, ValidationError } from '@ai-engine/shared';
import { requireBody, type ApiContext } from '../context';

/**
 * The settings a person may change while the system runs.
 *
 * The screen is generated from the descriptors rather than written twice, so a
 * new setting is one entry in the domain list and appears here with its own
 * explanation. Secrets travel one way only: in, never out.
 *
 * Two scopes: the installation, and one project. A project may only override a
 * setting whose descriptor says it makes sense per project — how much runs at
 * once is a property of the machine, not of a repository — and the repository
 * refuses the rest rather than storing a value nothing will ever read.
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

  router.get('/api/projects/:id/settings', async ({ params }) => {
    const project = await context.repos.projects.getById(params['id']!);
    return { settings: await context.repos.settings.describeForProject(project.id) };
  });

  router.put('/api/projects/:id/settings', async ({ params, body }) => {
    const project = await context.repos.projects.getById(params['id']!);
    const input = requireBody<{ values: Record<string, string> }>(body, ['values']);
    if (typeof input.values !== 'object' || input.values === null) {
      throw new ValidationError('values must be an object of setting keys');
    }
    for (const [key, value] of Object.entries(input.values)) {
      if (typeof value !== 'string') throw new ValidationError(`The value for "${key}" must be text`);
      // An empty value is how the screen says "use the installation's", which is
      // different from storing an empty string and different again from never
      // having set one.
      if (value === '') await context.repos.settings.clearForProject(project.id, key);
      else await context.repos.settings.setForProject(project.id, key, value);
    }
    return { settings: await context.repos.settings.describeForProject(project.id) };
  });

  router.delete('/api/projects/:id/settings/:key', async ({ params }) => {
    const project = await context.repos.projects.getById(params['id']!);
    await context.repos.settings.clearForProject(project.id, params['key']!);
    return { settings: await context.repos.settings.describeForProject(project.id) };
  });
}
