import type { PgBoss } from 'pg-boss';

import { syncBiblesFromDbl } from '@/domains/bibles/sync/dbl-bible-sync';
import { syncBooksFromDbl } from '@/domains/books/sync/dbl-book-sync';
import { syncLanguagesFromDbl } from '@/domains/languages/sync/dbl-language-sync';

import { logger } from '../lib/logger';

/** Queue name for the DBL catalogue sync job. */
export const QUEUE_DBL_SYNC = 'dbl-sync';

/**
 * Registers the DBL sync worker with pg-boss.
 *
 * (Note: The background schedule has been removed. If automated syncs are
 * needed in the future, put the required cron schedule in the environment
 * variables and configure it here, rather than hardcoding a Sunday schedule.)
 *
 * When triggered, it orchestrates the domain syncs sequentially to keep
 * Fluent's local Bible catalogue in sync with the upstream DBL/API.Bible
 * catalogue.
 *
 * Error handling: each sync step (`syncLanguagesFromDbl`, `syncBiblesFromDbl`,
 * `syncBooksFromDbl`) returns a Result; a failed step throws so pg-boss
 * catches it and routes to its retry/dead-letter machinery.
 */
export async function registerDblSyncWorker(boss: PgBoss) {
  // To trigger it manually, send a job to this queue: await boss.send(QUEUE_DBL_SYNC, {});
  await boss.createQueue(QUEUE_DBL_SYNC);

  await boss.work(QUEUE_DBL_SYNC, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    const jobId = (job as { id?: string }).id ?? 'unknown';
    logger.info('Running scheduled DBL sync job', { jobId });
    try {
      logger.info('Starting step 1/3: Syncing languages from DBL...');
      const langResult = await syncLanguagesFromDbl();
      if (!langResult.ok) throw new Error(`Language sync failed: ${langResult.error.message}`);

      logger.info('Starting step 2/3: Syncing bibles from DBL...');
      const biblesResult = await syncBiblesFromDbl();
      if (!biblesResult.ok) throw new Error(`Bibles sync failed: ${biblesResult.error.message}`);

      logger.info('Starting step 3/3: Syncing books from DBL...');
      const booksResult = await syncBooksFromDbl();
      if (!booksResult.ok) throw new Error(`Books sync failed: ${booksResult.error.message}`);

      logger.info('DBL sync job completed successfully', {
        languages: langResult.data,
        bibles: biblesResult.data,
        books: booksResult.data,
      });
    } catch (error) {
      // Re-throw so pg-boss marks this job as failed and applies its
      // retry/dead-letter policy.
      logger.error('DBL sync job failed', { error });
      throw error;
    }
  });

  logger.info(`Registered worker for queue: ${QUEUE_DBL_SYNC}`);
}
