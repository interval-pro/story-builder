import { createLogger, HttpRouter, loadConfig } from '@ai-engine/shared';
import { Database } from '@ai-engine/db';
import { createApiContext } from './context';
import { registerStoryRoutes } from './routes/stories';
import { registerTaskRoutes } from './routes/tasks';
import { registerReviewRoutes } from './routes/reviews';
import { registerBrainRoutes } from './routes/brain';
import { registerSystemRoutes } from './routes/system';
import { registerProjectRoutes } from './routes/projects';
import { registerQueueRoutes } from './routes/queue';
import { registerIdeaRoutes } from './routes/ideas';
import { registerChatRoutes } from './routes/chat';
import { registerSettingsRoutes } from './routes/settings';
import { registerUsageRoutes } from './routes/usage';

const logger = createLogger('api-service');

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database();
  const context = createApiContext(db);
  const router = new HttpRouter('api', logger);

  registerSystemRoutes(router, context);
  registerProjectRoutes(router, context);
  registerSettingsRoutes(router, context);
  registerQueueRoutes(router, context);
  registerUsageRoutes(router, context);
  registerIdeaRoutes(router, context);
  registerChatRoutes(router, context);
  registerStoryRoutes(router, context);
  registerTaskRoutes(router, context);
  registerReviewRoutes(router, context);
  registerBrainRoutes(router, context);

  const server = router.listen(config.service.apiPort);

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    server.close(() => {
      void db.close().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('api crashed', { error });
  process.exit(1);
});
