import { and, eq, inArray } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import { ai_suggestion_jobs, ai_suggestions } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

export async function queueAiSuggestionJobs(
  jobs: {
    projectUnitId: number;
    bibleId: number;
    bookCode: string;
    chapterNumber: number;
    verseStart: number;
    verseEnd: number;
  }[],
  tx?: DbTransaction
): Promise<Result<void>> {
  const database = tx || db;
  try {
    if (jobs.length === 0) return ok(undefined);

    await database
      .insert(ai_suggestion_jobs)
      .values(jobs)
      .onConflictDoNothing({
        target: [
          ai_suggestion_jobs.projectUnitId,
          ai_suggestion_jobs.bookCode,
          ai_suggestion_jobs.chapterNumber,
          ai_suggestion_jobs.verseStart,
          ai_suggestion_jobs.verseEnd,
        ],
      });

    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to queue AI suggestion jobs',
      context: { jobCount: jobs.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getAiSuggestions(
  projectUnitId: number,
  bibleTextIds: number[],
  tx?: DbTransaction
) {
  const database = tx || db;
  try {
    if (bibleTextIds.length === 0) return ok([]);

    const results = await database
      .select()
      .from(ai_suggestions)
      .where(
        and(
          eq(ai_suggestions.projectUnitId, projectUnitId),
          inArray(ai_suggestions.bibleTextId, bibleTextIds)
        )
      );

    return ok(results);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to fetch AI suggestions',
      context: { projectUnitId, textIdsCount: bibleTextIds.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function logAiSuggestionUsage(
  userId: number,
  bibleTextId: number,
  projectUnitId: number,
  wasUsed: boolean,
  tx?: DbTransaction
): Promise<Result<void>> {
  const database = tx || db;
  try {
    // Import ai_suggestion_usage_log inside to avoid circular deps if any,
    // but better to import it at the top
    const { ai_suggestion_usage_log } = await import('@/db/schema');
    await database
      .insert(ai_suggestion_usage_log)
      .values({
        userId,
        bibleTextId,
        projectUnitId,
        wasUsed,
      })
      .onConflictDoUpdate({
        target: [ai_suggestion_usage_log.userId, ai_suggestion_usage_log.bibleTextId],
        set: { wasUsed }, // Update if the user later accepts it
      });

    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to log AI suggestion usage',
      context: { userId, bibleTextId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
