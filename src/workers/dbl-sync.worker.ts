import type { PgBoss } from 'pg-boss';

import { logger } from '../lib/logger';
import { ingestDblBibles } from './ingest-bibles';

/** Queue name for the weekly DBL catalogue sync job. */
export const QUEUE_DBL_SYNC = 'dbl-sync';

/**
 * Registers the DBL sync worker with pg-boss.
 *
 * This worker runs on a weekly cron schedule (Sunday midnight UTC) to keep
 * Fluent's local Bible catalogue in sync with the upstream DBL/API.Bible
 * catalogue. It delegates the actual work to `ingestDblBibles()`.
 *
 * Error handling: `ingestDblBibles()` propagates errors for total failures,
 * which pg-boss catches and routes to its retry/dead-letter machinery.
 * Partial failures (some Bibles errored but others succeeded) are logged
 * but do not fail the job.
 */
export async function registerDblSyncWorker(boss: PgBoss) {
  // To trigger it manually, send a job to this queue: await boss.send(QUEUE_DBL_SYNC, {});

  await boss.work(QUEUE_DBL_SYNC, async (jobs) => {
    // pg-boss v9+ passes an array of Job objects; extract the first one.
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    logger.info('Running scheduled DBL sync job', { jobId: (job as any).id });
    try {
      await ingestDblBibles();
      logger.info('DBL sync job completed successfully');
    } catch (error) {
      // Re-throw so pg-boss marks this job as failed and applies its
      // retry/dead-letter policy.
      logger.error('DBL sync job failed', { error });
      throw error;
    }
  });

  logger.info(`Registered worker for queue: ${QUEUE_DBL_SYNC}`);
}
