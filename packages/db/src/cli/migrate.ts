import { Database } from '../client';
import { migrate, resetDatabase } from '../migrator';

async function main(): Promise<void> {
  const db = new Database();
  try {
    if (process.argv.includes('--reset')) {
      await resetDatabase(db);
    }
    const applied = await migrate(db);
    if (applied.length === 0) process.stdout.write('Database is up to date.\n');
    else process.stdout.write(`Applied migrations:\n${applied.map((name) => `  - ${name}`).join('\n')}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
