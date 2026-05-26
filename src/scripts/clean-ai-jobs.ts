import { and, inArray, lt } from 'drizzle-orm';
import process from 'node:process';

import { db } from '@/db';
import { ai_suggestion_jobs } from '@/db/schema';
import { logger } from '@/lib/logger';

async function main() {
  logger.info('Starting AI Queue Cleanup Job...');

  try {
    // Delete jobs that are 'completed' or 'failed' AND were created more than 7 days ago
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const deleted = await db
      .delete(ai_suggestion_jobs)
      .where(
        and(
          inArray(ai_suggestion_jobs.status, ['completed', 'failed']),
          lt(ai_suggestion_jobs.createdAt, sevenDaysAgo)
        )
      )
      .returning({ id: ai_suggestion_jobs.id });

    logger.info(`Successfully cleaned up ${deleted.length} old AI jobs.`);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to run AI Queue Cleanup' });
    process.exit(1);
  }

  process.exit(0);
}

void main();
