import 'dotenv/config';

import { cleanupExpiredFiles, initializeFileStorage } from '@/lib/file-storage';
import { logger } from '@/lib/logger';
import { initializeQueue, QUEUE_NAMES, stopQueue } from '@/lib/queue';

import type { WorkerMetricsHooks } from './usfm-export.worker';

import { registerAiTriggerWorker } from './ai-trigger.worker';
import { registerUSFMExportWorker } from './usfm-export.worker';

interface WorkerMetrics {
  startTime: number;
  jobsProcessed: number;
  jobsFailed: number;
  totalProcessingTime: number;
  activeJobs: number;
}

const workerMetrics: WorkerMetrics = {
  startTime: Date.now(),
  jobsProcessed: 0,
  jobsFailed: 0,
  totalProcessingTime: 0,
  activeJobs: 0,
};

const metricsHooks: WorkerMetricsHooks = {
  onBatchStart(count) {
    workerMetrics.activeJobs += count;
  },
  onBatchEnd(count) {
    workerMetrics.activeJobs = Math.max(workerMetrics.activeJobs - count, 0);
  },
  onJobSuccess(durationMs) {
    workerMetrics.jobsProcessed += 1;
    workerMetrics.totalProcessingTime += durationMs;
  },
  onJobFailure(durationMs) {
    workerMetrics.jobsFailed += 1;
    workerMetrics.totalProcessingTime += durationMs;
  },
};

async function startWorker() {
  try {
    logger.info('Starting pg-boss worker in WebJob');

    await initializeFileStorage();
    logger.info('File storage initialized');

    const boss = await initializeQueue();

    await boss.createQueue(QUEUE_NAMES.USFM_EXPORT, {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 3600,
    });

    await boss.createQueue(QUEUE_NAMES.AI_SUGGESTION_TRIGGER, {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 3600,
    });

    await registerUSFMExportWorker(boss, metricsHooks);
    await registerAiTriggerWorker(boss);

    logger.info('Worker started and listening for jobs');

    const cleanupInterval = setInterval(() => {
      cleanupExpiredFiles().catch((error) => {
        logger.error('Cleanup task failed', { error });
      });
    }, 3600000);

    const heartbeatInterval = setInterval(
      async () => {
        try {
          const uptimeSeconds = (Date.now() - workerMetrics.startTime) / 1000;
          const avgProcessingTimeMs =
            workerMetrics.jobsProcessed > 0
              ? workerMetrics.totalProcessingTime / workerMetrics.jobsProcessed
              : 0;

          const rawStats = await boss.getQueueStats(QUEUE_NAMES.USFM_EXPORT);
          const stats = rawStats as any;

          const queueSize = (stats?.created ?? 0) + (stats?.retry ?? 0) + (stats?.active ?? 0);

          logger.info('Worker heartbeat', {
            queueName: QUEUE_NAMES.USFM_EXPORT,
            uptimeSeconds: Math.floor(uptimeSeconds),
            activeJobs: workerMetrics.activeJobs,
            processed: workerMetrics.jobsProcessed,
            failed: workerMetrics.jobsFailed,
            avgProcessingTimeSeconds: Number((avgProcessingTimeMs / 1000).toFixed(2)),
            queueSize,
            memory: {
              rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
              heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            },
          });
        } catch (error) {
          logger.error('Error in heartbeat', { error });
        }
      },
      5 * 60 * 1000
    );

    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down worker`);
      clearInterval(heartbeatInterval);
      clearInterval(cleanupInterval);

      try {
        const maxWait = 30000;
        const checkInterval = 1000;
        let waited = 0;

        while (workerMetrics.activeJobs > 0 && waited < maxWait) {
          logger.info(
            `Waiting for ${workerMetrics.activeJobs} active job(s) to complete before shutdown`
          );
          await new Promise((resolve) => setTimeout(resolve, checkInterval));
          waited += checkInterval;
        }

        if (workerMetrics.activeJobs > 0) {
          logger.warn(`Force shutdown with ${workerMetrics.activeJobs} active job(s)`);
        }

        await stopQueue();
        logger.info('Worker shut down');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', { error });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception in worker', {
        error: error.message,
        stack: error.stack,
      });
      void stopQueue();
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection in worker', { reason });
      void stopQueue();
      process.exit(1);
    });
  } catch (error) {
    logger.error('Failed to start worker', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

startWorker();
