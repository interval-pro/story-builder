import { createLogger } from '@ai-engine/shared';
import { Database } from '@ai-engine/db';
import { Worker } from './worker';

const logger = createLogger('worker-service');

async function main(): Promise<void> {
  const db = new Database();
  const worker = new Worker({ db, logger });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    worker.stop();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await worker.start();
  await db.close();
}

main().catch((error) => {
  logger.error('worker crashed', { error });
  process.exit(1);
});
