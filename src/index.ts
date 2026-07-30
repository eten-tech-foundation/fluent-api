import 'dotenv/config';
import { serve } from '@hono/node-server';

import env from '@/env';
import { cleanupExpiredFiles, initializeFileStorage } from '@/lib/file-storage';
import { logger } from '@/lib/logger';
import { initializeQueue, QUEUE_NAMES, stopQueue } from '@/lib/queue';
import { registerAiTriggerWorker } from '@/workers/ai-trigger.worker';
import { registerUSFMExportWorker } from '@/workers/usfm-export.worker';

import app from './app';

async function startServer() {
  try {
    logger.info('Starting Fluent API server');

    await initializeFileStorage();
    logger.info('File storage initialized');

    logger.info('Initializing queue');
    const boss = await initializeQueue();

    logger.info('Ensuring USFM export queue exists');
    await boss.createQueue(QUEUE_NAMES.USFM_EXPORT, {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 3600,
    });

    logger.info('Ensuring AI suggestion trigger queue exists');
    await boss.createQueue(QUEUE_NAMES.AI_SUGGESTION_TRIGGER, {
      policy: 'exclusive',
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 3600,
    });

    logger.info('Queue ready');

    // Register workers in-process to avoid dual-container memory crashes on Azure
    await registerUSFMExportWorker(boss, {});
    await registerAiTriggerWorker(boss, {});

    const cleanupInterval = setInterval(() => {
      cleanupExpiredFiles().catch((error) => {
        logger.error('Cleanup task failed', { error });
      });
    }, 3600000);

    const server = serve({
      fetch: app.fetch,
      port: env.PORT,
    });

    logger.info(`Server is running on port ${env.PORT}`);

    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down server`);
      try {
        clearInterval(cleanupInterval);

        server.close(() => {
          logger.info('HTTP server closed');
        });

        await stopQueue();

        logger.info('Shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', { error });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => {
      void gracefulShutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      void gracefulShutdown('SIGINT');
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

startServer();
