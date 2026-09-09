import { createLogger, loadConfig, sleep } from '@ai-engine/shared';
import { Database } from '@ai-engine/db';
import { Orchestrator } from './orchestrator';

const logger = createLogger('orchestrator-service');

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database();
  const orchestrator = new Orchestrator(db);
  let running = true;

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    running = false;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('orchestrator started', { tickMs: config.service.orchestratorTickMs });

  while (running) {
    try {
      const result = await orchestrator.tick({ jobLeaseSeconds: config.service.jobLeaseSeconds });
      if (result.reclaimed > 0 || result.failedTasks > 0) {
        logger.info('tick completed', result);
      }
    } catch (error) {
      logger.error('tick failed', { error });
    }
    await sleep(config.service.orchestratorTickMs);
  }

  await db.close();
  logger.info('orchestrator stopped');
}

main().catch((error) => {
  logger.error('orchestrator crashed', { error });
  process.exit(1);
});
