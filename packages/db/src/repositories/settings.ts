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

  constructor(private readonly db: Queryable) {}

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
