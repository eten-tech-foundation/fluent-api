import 'dotenv/config';
import { serve } from '@hono/node-server';

import env from '@/env';
import { initializeBlobStorage, isBlobStorageConfigured } from '@/lib/blob-storage';
import { logger } from '@/lib/logger';
import { ensureExportQueues, initializeQueue, QUEUE_NAMES, stopQueue } from '@/lib/queue';

import app from './app';

async function startServer() {
  try {
    logger.info('Starting Fluent API server');

    if (isBlobStorageConfigured()) {
      await initializeBlobStorage();
    } else {
      logger.warn(
        'R2 export storage not configured — async USFM export endpoints will respond 503'
      );
    }

    logger.info('Initializing queue');
    const boss = await initializeQueue();

    logger.info('Ensuring USFM export queues exist');
    await ensureExportQueues(boss);

    logger.info('Ensuring AI suggestion trigger queue exists');
    await boss.createQueue(QUEUE_NAMES.AI_SUGGESTION_TRIGGER, {
      policy: 'exclusive',
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 3600,
    });

    logger.info('Queue ready');

    const server = serve({
      fetch: app.fetch,
      port: env.PORT,
    });

    logger.info(`Server is running on port ${env.PORT}`);

    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down server`);
      try {
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
