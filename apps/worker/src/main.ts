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

  // One worker runs every job on the machine. A promise nobody awaited, failing
  // somewhere inside one of them, used to end the process: every job it held
  // stayed locked until its lease ran out, and a project's directory with it.
  // It is logged as the error it is and the other jobs carry on. A job that
  // really did fail still fails through its own path.
  process.on('unhandledRejection', (reason) => {
    logger.error('a promise failed and nothing was waiting for it; the worker keeps running', {
      error: reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason),
    });
  });

  await worker.start();
  await db.close();
}

main().catch((error) => {
  logger.error('worker crashed', { error });
  process.exit(1);
});
