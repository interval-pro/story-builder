import { createLogger, HttpRouter, loadConfig } from '@ai-engine/shared';
import { Database } from '@ai-engine/db';
import { SandboxManager } from './sandbox-manager';

const logger = createLogger('sandbox-manager-service');

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database();
  const manager = new SandboxManager(db, logger);

  const reconciled = await manager.reconcile().catch((error) => {
    logger.warn('reconcile failed at startup', { error });
    return { checked: 0, repaired: 0 };
  });
  logger.info('startup reconcile complete', reconciled);

  const router = new HttpRouter('sandbox-manager', logger);

  router.get('/health', async () => ({ status: 'ok', ...(await manager.health()) }));

  router.post('/sandboxes', async ({ body }) => {
    const input = body as { taskId: string; branch: string; baseCommit: string; mode: 'READ_ONLY' | 'READ_WRITE' };
    const sandbox = await manager.ensure(input);
    return { id: sandbox.id, workspacePath: sandbox.workspacePath, mode: sandbox.mode, status: sandbox.status };
  });

  router.post('/sandboxes/:taskId/exec', async ({ params, body }) => {
    const input = body as { command: string; cwd?: string; timeoutMs: number; env?: Record<string, string>; readOnly?: boolean };
    return manager.exec({ taskId: params['taskId']!, ...input });
  });

  router.post('/sandboxes/:taskId/mode', async ({ params, body }) => {
    const { mode } = body as { mode: 'READ_ONLY' | 'READ_WRITE' };
    const sandbox = await manager.setMode(params['taskId']!, mode);
    return { id: sandbox.id, mode: sandbox.mode, status: sandbox.status };
  });

  router.post('/sandboxes/:taskId/pause', async ({ params }) => {
    await manager.pause(params['taskId']!);
    return { ok: true };
  });

  router.post('/sandboxes/:taskId/resume', async ({ params }) => {
    await manager.resume(params['taskId']!);
    return { ok: true };
  });

  router.delete('/sandboxes/:taskId', async ({ params, query }) => {
    await manager.destroy(params['taskId']!, { keepWorkspace: query.get('keepWorkspace') === 'true' });
    return { ok: true };
  });

  const server = router.listen(config.service.sandboxManagerPort);

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
  logger.error('sandbox manager crashed', { error });
  process.exit(1);
});
