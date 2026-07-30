import 'dotenv/config';
import { serve } from '@hono/node-server';

import { reclaimOrphanedStorageObjects } from '@/domains/verse-audio/verse-audio.service';
import env from '@/env';
import { isAudioStorageConfigured } from '@/lib/audio-storage';
import { cleanupExpiredFiles, initializeFileStorage } from '@/lib/file-storage';
import { logger } from '@/lib/logger';
import { initializeQueue, QUEUE_NAMES, stopQueue } from '@/lib/queue';

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

    const cleanupInterval = setInterval(() => {
      cleanupExpiredFiles().catch((error) => {
        logger.error('Cleanup task failed', { error });
      });
    }, 3600000);

    // Deleting a project unit cascades its recordings away, but Postgres cannot
    // delete an object in a bucket — this sweep is what actually frees those
    // bytes. Skipped entirely when R2 is unconfigured (audio is then off).
    const audioReclaimInterval = isAudioStorageConfigured()
      ? setInterval(() => {
          reclaimOrphanedStorageObjects().catch((error) => {
            logger.error('Verse audio reclaim task failed', { error });
          });
        }, env.AUDIO_RECLAIM_INTERVAL_MS)
      : null;

    const server = serve({
      fetch: app.fetch,
      port: env.PORT,
    });

    logger.info(`Server is running on port ${env.PORT}`);

    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down server`);
      try {
        clearInterval(cleanupInterval);
        if (audioReclaimInterval) clearInterval(audioReclaimInterval);

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
