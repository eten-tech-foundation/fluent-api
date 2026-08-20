import type { DblClient } from '@/lib/services/dbl/dbl.client';
import type { Result } from '@/lib/types';

import * as biblesRepository from '@/domains/bibles/bibles.repository';
import { logger } from '@/lib/logger';
import { dblClient } from '@/lib/services/dbl/dbl.client';
import { err, ErrorCode } from '@/lib/types';

import type { DblBookUpsertInput } from '../books.repository';

import * as booksRepository from '../books.repository';

export interface DblBookSyncSummary {
  totalBiblesProcessed: number;
  totalBooksLinked: number;
}

/**
 * Fetches books for every Bible currently in the database and upserts/links
 * them. Bibles are processed sequentially to avoid hammering the DBL API.
 *
 * Note: `syncBiblesFromDbl` should generally be called BEFORE this
 * to ensure the bibles table is fully populated.
 */
export async function syncBooksFromDbl(
  client: DblClient = dblClient
): Promise<Result<DblBookSyncSummary>> {
  const biblesResult = await biblesRepository.getAll();
  if (!biblesResult.ok) return biblesResult;

  const dbBibles = biblesResult.data.filter((b) => b.externalId && b.provider === 'dbl');

  let totalBooksLinked = 0;
  let errorCount = 0;

  for (const bible of dbBibles) {
    if (!bible.externalId) continue;

    try {
      const booksResult = await client.getBooks(bible.externalId);
      if (!booksResult.ok) {
        logger.error(
          `Failed to fetch books from DBL for bible ${bible.externalId}: ${booksResult.error.message}`
        );
        errorCount++;
        continue; // Keep going for other bibles
      }

      const rows: DblBookUpsertInput[] = booksResult.data.map((b) => ({
        code: b.id,
        eng_display_name: b.name,
      }));

      const upsertResult = await booksRepository.upsertFromDbl(bible.id, rows);
      if (!upsertResult.ok) {
        errorCount++;
        continue; // Keep going
      }

      totalBooksLinked += upsertResult.data.linkedBooks;
    } catch (error) {
      errorCount++;
      logger.error(`Unexpected error syncing books for bible ${bible.externalId}`, { error });
    }
  }

  // We could return a partial success/error, but returning ok if we processed *some* is standard for background syncs.
  // We'll log the error count.
  if (errorCount > 0 && errorCount === dbBibles.length) {
    // Every single Bible failed — treat as a total failure.
    logger.error('Failed to sync books for all bibles', { errorCount });
    return err(ErrorCode.INTERNAL_ERROR);
  }

  return {
    ok: true,
    data: {
      totalBiblesProcessed: dbBibles.length - errorCount,
      totalBooksLinked,
    },
  };
}
