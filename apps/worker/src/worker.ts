import { createLogger, loadConfig, newId, sleep, type Logger } from '@ai-engine/shared';
import type { Job, JobType } from '@ai-engine/domain';
import { Database } from '@ai-engine/db';
import { JobQueue } from '@ai-engine/queue';
import { buildJobContext } from './job-context';
import { handleResearch } from './handlers/research';
import { handleReviewGenerate, handleReviewRegenerate } from './handlers/review';
import { handleImplementation } from './handlers/implementation';
import { handleQa } from './handlers/qa';
import { handleFinalReport } from './handlers/final';
import { handleIntegrationValidation, handlePushAndPullRequest } from './handlers/integration';
import {
  handleKnowledgeRefresh,
  handleLearning,
  handleRuntimeManifest,
  handleSandboxTeardown,
} from './handlers/maintenance';

export interface WorkerOptions {
  db: Database;
  workerId?: string;
  jobTypes?: JobType[];
  logger?: Logger;
}

/**
 * Claims jobs from the durable queue and runs them. A worker holds no state of
 * its own: everything it needs is loaded from Postgres at the start of a job,
 * so a crashed worker is replaceable mid-task.
 */
export class Worker {
  private readonly db: Database;
  private readonly queue: JobQueue;
  private readonly logger: Logger;
  readonly workerId: string;
  private running = false;

  constructor(private readonly options: WorkerOptions) {
    this.db = options.db;
    this.queue = new JobQueue(options.db);
    this.workerId = options.workerId ?? `worker-${newId().slice(0, 8)}`;
    this.logger = (options.logger ?? createLogger('worker')).child({ workerId: this.workerId });
  }

  async runOnce(): Promise<Job | null> {
    const job = await this.queue.claim(this.workerId, this.options.jobTypes);
    if (!job) return null;

    const logger = this.logger.child({ jobId: job.id, jobType: job.jobType });
    logger.info('job claimed', { attempt: job.attempt });

    // Renew the lease while the work is genuinely in progress.
    const config = loadConfig();
    const heartbeatMs = Math.max(30_000, Math.floor((config.service.jobLeaseSeconds * 1000) / 3));
    const heartbeat = setInterval(() => {
      void this.queue.heartbeat(job.id, this.workerId).then((held) => {
        if (!held) logger.warn('the lease on this job was taken away while it was running');
      });
    }, heartbeatMs);

    try {
      await this.dispatch(job);
      await this.queue.complete(job.id);
      logger.info('job completed');
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
      const { retrying } = await this.queue.fail(job.id, message);
      logger.error('job failed', { retrying, error });
    } finally {
      clearInterval(heartbeat);
    }
    return job;
  }

  private async dispatch(job: Job): Promise<void> {
    const taskId = String(job.payload['taskId'] ?? job.taskId ?? '');
    if (!taskId) throw new Error(`Job ${job.id} has no task`);

    const context = await buildJobContext({ db: this.db, job, workerId: this.workerId, logger: this.logger });

    switch (job.jobType) {
      case 'RESEARCH':
        return handleResearch(context);
      case 'REVIEW_GENERATE':
        return handleReviewGenerate(context);
      case 'REVIEW_REGENERATE':
        return handleReviewRegenerate(context);
      case 'IMPLEMENTATION':
        return handleImplementation(context, 'IMPLEMENTATION');
      case 'FIX':
        return handleImplementation(context, 'FIX');
      case 'QA':
        return handleQa(context);
      case 'FINAL_REPORT':
        return handleFinalReport(context);
      case 'INTEGRATION_VALIDATION':
        return handleIntegrationValidation(context);
      case 'PUSH_AND_PR':
        return handlePushAndPullRequest(context);
      case 'LEARNING':
        return handleLearning(context);
      case 'KNOWLEDGE_REFRESH':
        return handleKnowledgeRefresh(context);
      case 'RUNTIME_MANIFEST':
        return handleRuntimeManifest(context);
      case 'SANDBOX_TEARDOWN':
        return handleSandboxTeardown(context, taskId);
      default:
        throw new Error(`Unknown job type: ${job.jobType}`);
    }
  }

  async start(): Promise<void> {
    const config = loadConfig();
    this.running = true;
    this.logger.info('worker started', { concurrency: config.service.workerConcurrency });

    const loops = Array.from({ length: Math.max(1, config.service.workerConcurrency) }, async () => {
      while (this.running) {
        const job = await this.runOnce().catch((error) => {
          this.logger.error('worker loop error', { error });
          return null;
        });
        if (!job) await sleep(config.service.workerPollMs);
      }
    });

    await Promise.all(loops);
  }

  stop(): void {
    this.running = false;
  }
}
