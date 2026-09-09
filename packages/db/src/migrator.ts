import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@ai-engine/shared';
import type { Database } from './client';

const logger = createLogger('migrator');

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const migrations: MigrationFile[] = [];
  for (const name of entries) {
    const sql = await readFile(path.join(dir, name), 'utf8');
    migrations.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return migrations;
}

async function ensureMigrationsTable(db: Database): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS system_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function migrate(db: Database, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await ensureMigrationsTable(db);
  const applied = new Map(
    (await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM system_migrations')).map((row) => [
      row.name,
      row.checksum,
    ]),
  );
  const migrations = await loadMigrations(dir);
  const executed: string[] = [];
  for (const migration of migrations) {
    const previous = applied.get(migration.name);
    if (previous) {
      if (previous !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} was modified after it was applied. Create a new migration instead.`,
        );
      }
      continue;
    }
    logger.info('applying migration', { name: migration.name });
    await db.transaction(async (tx) => {
      await tx.query(migration.sql);
      await tx.query('INSERT INTO system_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
    });
    executed.push(migration.name);
  }
  return executed;
}

/** Drops the public schema. Only used by `ai-engine` development resets. */
export async function resetDatabase(db: Database): Promise<void> {
  logger.warn('dropping public schema');
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
}
