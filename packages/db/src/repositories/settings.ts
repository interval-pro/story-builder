import {
  SETTING_DESCRIPTORS,
  SETTING_KEYS,
  settingAsBoolean,
  settingAsInteger,
  settingDescriptor,
  type Setting,
  type SettingDescriptor,
} from '@ai-engine/domain';
import { ValidationError } from '@ai-engine/shared';
import type { Queryable } from '../client';
import { camelizeAll } from '../mapping';

const COLUMNS = 'key, value, secret, updated_at';

/**
 * Checks a value against its own descriptor before it is stored.
 *
 * Both scopes store into different tables and both must refuse the same things,
 * so the rules live here rather than being written twice and drifting.
 */
function validateSetting(key: string, value: string): SettingDescriptor {
  const descriptor = settingDescriptor(key);
  if (!descriptor) throw new ValidationError(`Unknown setting "${key}"`);
  if (descriptor.kind === 'integer') {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) throw new ValidationError(`${descriptor.label} must be a whole number`);
    if (descriptor.min !== undefined && parsed < descriptor.min) {
      throw new ValidationError(`${descriptor.label} cannot be below ${descriptor.min}`);
    }
    if (descriptor.max !== undefined && parsed > descriptor.max) {
      throw new ValidationError(`${descriptor.label} cannot be above ${descriptor.max}`);
    }
  }
  if (descriptor.kind === 'choice' && !descriptor.choices?.some((choice) => choice.value === value)) {
    throw new ValidationError(`${descriptor.label} must be one of the offered choices`);
  }
  return descriptor;
}


/**
 * How many milliseconds a resolved value is reused for.
 *
 * Every claim reads the concurrency and the pause flag, which is once a second
 * per worker loop. A couple of seconds of staleness on a number a person changed
 * by hand is not a problem; a query per poll for a value that changes twice a
 * day is waste.
 */
const CACHE_TTL_MS = 2_000;

/**
 * The settings the cockpit may change while the system runs.
 *
 * A value is resolved as: what is stored, then the environment variable the
 * descriptor names, then the descriptor's default. That order is what lets an
 * existing installation keep working from its `.env.local` while the cockpit
 * takes over the same value without a restart, and it is also why nothing here
 * writes to that file: two sources of truth for one number is how they drift.
 */
export class SettingsRepository {
  private cache: { at: number; values: Map<string, string> } | null = null;
  private projectCache = new Map<string, { at: number; values: Map<string, string> }>();

  constructor(private readonly db: Queryable) {}

  /**
   * The same reader, scoped to one project.
   *
   * A project's value wins over the global one for that project only. Everything
   * else about resolution is unchanged, so a caller that does not care about
   * projects keeps working and one that does says so once.
   */
  forProject(projectId: string): ScopedSettings {
    return new ScopedSettings(this, projectId);
  }

  private async projectValues(projectId: string): Promise<Map<string, string>> {
    const cached = this.projectCache.get(projectId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.values;
    const rows = await this.db.query<{ key: string; value: string }>(
      'SELECT key, value FROM project_settings WHERE project_id = $1',
      [projectId],
    );
    const values = new Map(rows.map((row) => [row.key, row.value]));
    this.projectCache.set(projectId, { at: Date.now(), values });
    return values;
  }

  /** A project's own value for a key, before any fallback. */
  async projectRaw(projectId: string, key: string): Promise<string | undefined> {
    const stored = (await this.projectValues(projectId)).get(key);
    return stored !== undefined && stored !== '' ? stored : undefined;
  }

  async setForProject(projectId: string, key: string, value: string): Promise<void> {
    const descriptor = validateSetting(key, value);
    if (descriptor.scope !== 'both') {
      throw new ValidationError(`${descriptor.label} is set for the whole installation, not per project`);
    }
    await this.db.query(
      `INSERT INTO project_settings (project_id, key, value, secret) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, key) DO UPDATE SET value = $3, secret = $4, updated_at = now()`,
      [projectId, key, value, descriptor.kind === 'secret'],
    );
    this.projectCache.delete(projectId);
  }

  async clearForProject(projectId: string, key: string): Promise<void> {
    await this.db.query('DELETE FROM project_settings WHERE project_id = $1 AND key = $2', [projectId, key]);
    this.projectCache.delete(projectId);
  }

  /** Every setting a project may override, with where its effective value came from. */
  async describeForProject(projectId: string): Promise<
    (SettingDescriptor & {
      value: string;
      isSet: boolean;
      source: 'project' | 'stored' | 'environment' | 'default';
    })[]
  > {
    const own = await this.projectValues(projectId);
    const global = await this.describe();
    return global
      .filter((descriptor) => descriptor.scope === 'both')
      .map((descriptor) => {
        const override = own.get(descriptor.key);
        if (override === undefined || override === '') {
          return { ...descriptor, source: descriptor.source };
        }
        return {
          ...descriptor,
          value: descriptor.kind === 'secret' ? '' : override,
          isSet: true,
          source: 'project' as const,
        };
      });
  }

  private async values(): Promise<Map<string, string>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.values;
    const rows = await this.db.query<{ key: string; value: string }>('SELECT key, value FROM settings');
    const values = new Map(rows.map((row) => [row.key, row.value]));
    this.cache = { at: Date.now(), values };
    return values;
  }

  /** Forgets the cache, so a write is visible to the next read in this process. */
  invalidate(): void {
    this.cache = null;
  }

  async raw(key: string): Promise<string | undefined> {
    const stored = (await this.values()).get(key);
    if (stored !== undefined && stored !== '') return stored;
    const descriptor = settingDescriptor(key);
    const fromEnv = descriptor?.envVar ? process.env[descriptor.envVar] : undefined;
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    return undefined;
  }

  async text(key: string): Promise<string> {
    const descriptor = settingDescriptor(key);
    return (await this.raw(key)) ?? descriptor?.defaultValue ?? '';
  }

  async integer(key: string): Promise<number> {
    const descriptor = settingDescriptor(key);
    if (!descriptor) throw new ValidationError(`Unknown setting "${key}"`);
    return settingAsInteger(await this.raw(key), descriptor);
  }

  async boolean(key: string): Promise<boolean> {
    const descriptor = settingDescriptor(key);
    if (!descriptor) throw new ValidationError(`Unknown setting "${key}"`);
    return settingAsBoolean(await this.raw(key), descriptor);
  }

  /** The two values every claim needs, read together. */
  async queuePolicy(): Promise<{ concurrency: number; paused: boolean }> {
    return {
      concurrency: await this.integer(SETTING_KEYS.queueConcurrency),
      paused: await this.boolean(SETTING_KEYS.queuePaused),
    };
  }

  async list(): Promise<Setting[]> {
    return camelizeAll<Setting>(await this.db.query(`SELECT ${COLUMNS} FROM settings ORDER BY key`));
  }

  /**
   * What the settings screen shows: every descriptor with its resolved value,
   * and for a secret only whether one is set.
   *
   * Resolving here rather than in the cockpit means the screen shows the value
   * the system will actually use, including one that is still coming from an
   * environment variable nobody has overridden yet.
   */
  async describe(): Promise<
    (SettingDescriptor & { value: string; isSet: boolean; source: 'stored' | 'environment' | 'default' })[]
  > {
    const stored = await this.values();
    return Promise.all(
      SETTING_DESCRIPTORS.map(async (descriptor) => {
        const storedValue = stored.get(descriptor.key);
        const fromEnv = descriptor.envVar ? process.env[descriptor.envVar] : undefined;
        const source =
          storedValue !== undefined && storedValue !== ''
            ? ('stored' as const)
            : fromEnv !== undefined && fromEnv !== ''
              ? ('environment' as const)
              : ('default' as const);
        const resolved = (await this.raw(descriptor.key)) ?? descriptor.defaultValue;
        return {
          ...descriptor,
          // A secret never travels back out, only the fact that one exists.
          value: descriptor.kind === 'secret' ? '' : resolved,
          isSet: descriptor.kind === 'secret' ? resolved.length > 0 : true,
          source,
        };
      }),
    );
  }

  async set(key: string, value: string): Promise<void> {
    const descriptor = validateSetting(key, value);
    await this.db.query(
      `INSERT INTO settings (key, value, secret) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, secret = $3, updated_at = now()`,
      [key, value, descriptor.kind === 'secret'],
    );
    this.invalidate();
  }

  /** Removes an override, so the value falls back to the environment or default. */
  async clear(key: string): Promise<void> {
    await this.db.query('DELETE FROM settings WHERE key = $1', [key]);
    this.invalidate();
  }
}

/**
 * Settings as one project sees them.
 *
 * Resolution is project, then installation, then environment, then default. The
 * screen says which of the four a value came from, because "why is this model
 * being used" is otherwise unanswerable.
 */
export class ScopedSettings {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly projectId: string,
  ) {}

  async raw(key: string): Promise<string | undefined> {
    return (await this.settings.projectRaw(this.projectId, key)) ?? (await this.settings.raw(key));
  }

  async text(key: string): Promise<string> {
    const descriptor = settingDescriptor(key);
    return (await this.raw(key)) ?? descriptor?.defaultValue ?? '';
  }

  async integer(key: string): Promise<number> {
    const descriptor = settingDescriptor(key);
    if (!descriptor) throw new ValidationError(`Unknown setting "${key}"`);
    return settingAsInteger(await this.raw(key), descriptor);
  }

  async boolean(key: string): Promise<boolean> {
    const descriptor = settingDescriptor(key);
    if (!descriptor) throw new ValidationError(`Unknown setting "${key}"`);
    return settingAsBoolean(await this.raw(key), descriptor);
  }
}
