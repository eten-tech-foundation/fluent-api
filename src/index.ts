import 'dotenv/config';
import { serve } from '@hono/node-server';

import { reclaimOrphanedStorageObjects } from '@/domains/verse-audio/verse-audio.service';
import env from '@/env';
import { initializeAudioStorage, isAudioStorageConfigured } from '@/lib/audio-storage';
import { verifyBlobStorageOnBoot } from '@/lib/blob-storage';
import { logger } from '@/lib/logger';
import { ensureExportQueues, initializeQueue, QUEUE_NAMES, stopQueue } from '@/lib/queue';

import app from './app';

async function startServer() {
  try {
    logger.info('Starting Fluent API server');

    await verifyBlobStorageOnBoot();

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

    // Deleting a project unit cascades its recordings away, but Postgres cannot
    // delete an object in a bucket — this sweep is what actually frees those
    // bytes. It only starts once the bucket has answered, so bad credentials or
    // a missing bucket surface here instead of as an hourly failing sweep. Audio
    // being optional, a failed probe is logged and the API keeps serving (the
    // routes then fail per-request rather than taking the whole server down).
    let audioReclaimInterval: NodeJS.Timeout | null = null;
    if (isAudioStorageConfigured()) {
      try {
        await initializeAudioStorage();
        audioReclaimInterval = setInterval(() => {
          reclaimOrphanedStorageObjects().catch((error) => {
            logger.error('Verse audio reclaim task failed', { error });
          });
        }, env.AUDIO_RECLAIM_INTERVAL_MS);
      } catch (error) {
        logger.error('Verse audio storage unavailable; reclaim sweep disabled', { error });
      }
    }

    const server = serve({
      fetch: app.fetch,
      port: env.PORT,
    });

    logger.info(`Server is running on port ${env.PORT}`);

    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down server`);
      try {
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
