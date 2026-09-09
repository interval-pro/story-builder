import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { loadConfig, createLogger, type Logger } from '@ai-engine/shared';

const logger: Logger = createLogger('db');

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
  queryOne<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T | null>;
}

class PoolQueryable implements Queryable {
  constructor(private readonly pool: Pool) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(text, params as never[]);
    return result.rows;
  }

  async queryOne<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }
}

class ClientQueryable implements Queryable {
  constructor(private readonly client: PoolClient) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client.query<T>(text, params as never[]);
    return result.rows;
  }

  async queryOne<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }
}

export class Database implements Queryable {
  private readonly pool: Pool;
  private readonly delegate: PoolQueryable;

  constructor(connectionString?: string, maxConnections?: number) {
    const config = loadConfig();
    this.pool = new Pool({
      connectionString: connectionString ?? config.database.url,
      max: maxConnections ?? config.database.maxConnections,
      application_name: 'ai-engine',
    });
    this.pool.on('error', (error) => logger.error('idle client error', { error }));
    this.delegate = new PoolQueryable(this.pool);
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]> {
    return this.delegate.query<T>(text, params);
  }

  queryOne<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T | null> {
    return this.delegate.queryOne<T>(text, params);
  }

  /**
   * Runs the callback inside a single transaction. Creating a task transition
   * together with its follow-up job in one transaction is what makes crash
   * recovery safe.
   */
  async transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(new ClientQueryable(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error('rollback failed', { error: rollbackError });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

let singleton: Database | undefined;

export function getDatabase(): Database {
  if (!singleton) singleton = new Database();
  return singleton;
}

export async function closeDatabase(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = undefined;
  }
}
