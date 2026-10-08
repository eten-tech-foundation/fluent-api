import 'dotenv/config';
import { serve } from '@hono/node-server';

import { reclaimOrphanedStorageObjects } from '@/domains/verse-audio/verse-audio.service';
import env from '@/env';
import { initializeAudioStorage, isAudioStorageConfigured } from '@/lib/audio-storage';
import { verifyBlobStorageOnBoot } from '@/lib/blob-storage';
import { startDeadLetterMonitor } from '@/lib/dead-letter-queues';
import { logger } from '@/lib/logger';
import { initializeQueueWithRetry, stopQueue } from '@/lib/queue';

import app from './app';

// The listener opens before any external dependency is touched: Azure's
// startup probe kills the container if the port isn't open in time, and a
// database/storage flap must degrade those features (callers get 503) rather
// than take the whole site down with it. Each subsystem initializes on its own
// so one slow dependency cannot starve the others.
async function startServer() {
  try {
    logger.info('Starting Fluent API server');

    const server = serve({
      fetch: app.fetch,
      port: env.PORT,
    });

    logger.info(`Server is running on port ${env.PORT}`);

    let shuttingDown = false;
    let stopDeadLetterMonitor: (() => Promise<void>) | undefined;
    let audioReclaimInterval: NodeJS.Timeout | null = null;

    // Background init: each task is independent and never throws past its own
    // boundary. The queue loop keeps retrying until shutdown so a DB outage at
    // boot self-heals when connectivity returns.
    const queueReady = initializeQueueWithRetry(() => shuttingDown).then((boss) => {
      if (boss && !shuttingDown) {
        stopDeadLetterMonitor = startDeadLetterMonitor(boss);
      }
    });

    const blobVerified = verifyBlobStorageOnBoot().then(() => undefined);

    // Deleting a project unit cascades its recordings away, but Postgres cannot
    // delete an object in a bucket — this sweep is what actually frees those
    // bytes (and superseded takes on clean units). It only starts once the bucket
    // has answered, so bad credentials or a missing bucket surface here instead
    // of as an hourly failing sweep. Audio being optional, a failed probe is
    // logged and the API keeps serving; the probe result is recorded in the
    // storage module, so the verse-audio routes then answer 503 instead of a
    // 500 per request.
    const audioReady = (async () => {
      if (!isAudioStorageConfigured()) return;
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
    })();

    void Promise.allSettled([queueReady, blobVerified, audioReady]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.error('Background initialization task failed', { reason: result.reason });
        }
      }
    });

    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down server`);
      shuttingDown = true;
      try {
        if (audioReclaimInterval) clearInterval(audioReclaimInterval);
        // Stop the monitor's timer now but drain its in-flight sweep alongside
        // the listener close. Awaiting it first would hold the socket open for
        // up to DLQ_SHUTDOWN_TIMEOUT_MS of the orchestrator's grace period.
        // stopDeadLetterMonitor may be unset if shutdown arrives mid-init.
        const monitorStopped = stopDeadLetterMonitor?.() ?? Promise.resolve();

        server.close(() => {
          logger.info('HTTP server closed');
        });

        await monitorStopped;
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
