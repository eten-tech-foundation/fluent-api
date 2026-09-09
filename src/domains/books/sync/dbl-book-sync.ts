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
        eng_display_name: b.name || b.nameLong || b.id,
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

// ─── Audio availability sync ────────────────────────────────────────────────

export interface AudioAvailabilitySyncSummary {
  totalBiblesProcessed: number;
  totalBooksUpdated: number;
}

/**
 * Syncs book-level audio availability for all DBL Bibles.
 *
 * For each Bible with `has_audio = true`, queries `GET /audio-bibles/{id}/books`
 * to determine which books have audio, then updates the `has_audio` flag on
 * the `bible_books` junction table.
 *
 * Full-sync: ALL DBL Bibles are processed. Bibles with `has_audio = false`
 * are fast-pathed to clear any stale `has_audio` flags on their books (handles
 * the case where a publisher removes an Audio Bible from DBL). Bibles with
 * `has_audio = true` fetch their audio book list from DBL and update accordingly.
 *
 * If any `getAudioBibleBooks` request fails for a given Bible, the entire
 * update for that Bible is skipped to avoid persisting partial data.
 *
 * Note: `syncBooksFromDbl` should be called BEFORE this to ensure the
 * `bible_books` junction table is fully populated.
 */
export async function syncAudioAvailability(
  client: DblClient = dblClient
): Promise<Result<AudioAvailabilitySyncSummary>> {
  // 1. Fetch all DBL Bibles that have audio
  const biblesResult = await biblesRepository.getAll();
  if (!biblesResult.ok) return biblesResult;

  const dblBibles = biblesResult.data.filter((b) => b.externalId && b.provider === 'dbl');

  if (dblBibles.length === 0) {
    return { ok: true, data: { totalBiblesProcessed: 0, totalBooksUpdated: 0 } };
  }

  let totalBooksUpdated = 0;
  let errorCount = 0;

  for (const bible of dblBibles) {
    if (!bible.externalId) continue;

    try {
      if (!bible.hasAudio) {
        // Fast-path: clear audio availability for all books if the Bible has no audio.
        // This handles cases where DBL removed the last audio Bible.
        const updateResult = await booksRepository.updateAudioAvailability(bible.id, []);
        if (!updateResult.ok) {
          errorCount++;
        } else {
          totalBooksUpdated += updateResult.data.updated;
        }
        continue;
      }
      // 2. Fetch the full Bible metadata from DBL to get audioBible IDs
      const dblBibleResult = await client.getBible(bible.externalId);
      if (!dblBibleResult.ok) {
        logger.error(`Failed to fetch DBL Bible metadata for audio sync: ${bible.externalId}`, {
          error: dblBibleResult.error,
        });
        errorCount++;
        continue;
      }

      const dblAudioBibles = dblBibleResult.data.audioBibles;
      if (!dblAudioBibles || dblAudioBibles.length === 0) {
        continue;
      }

      // 3. Collect audio book codes from all associated Audio Bibles
      const audioBookCodes = new Set<string>();
      let audioBookFetchFailed = false;
      for (const audioBible of dblAudioBibles) {
        const audioBooksResult = await client.getAudioBibleBooks(audioBible.id);
        if (!audioBooksResult.ok) {
          logger.warn(
            `Failed to fetch audio books for audioBible ${audioBible.id} (text bible ${bible.externalId})`,
            { error: audioBooksResult.error }
          );
          audioBookFetchFailed = true;
          continue;
        }
        for (const book of audioBooksResult.data) {
          audioBookCodes.add(book.id);
        }
      }

      if (audioBookFetchFailed) {
        // Do not persist a partial Audio Bible result.
        errorCount++;
        continue;
      }

      // 4. Update bible_books.has_audio for this Bible
      const updateResult = await booksRepository.updateAudioAvailability(bible.id, [
        ...audioBookCodes,
      ]);
      if (!updateResult.ok) {
        errorCount++;
        continue;
      }

      totalBooksUpdated += updateResult.data.updated;
    } catch (error) {
      errorCount++;
      logger.error(`Unexpected error syncing audio availability for bible ${bible.externalId}`, {
        error,
      });
    }
  }

  if (errorCount > 0 && errorCount === dblBibles.length) {
    logger.error('Failed to sync audio availability for all bibles', { errorCount });
    return err(ErrorCode.INTERNAL_ERROR);
  }

  return {
    ok: true,
    data: {
      totalBiblesProcessed: dblBibles.length - errorCount,
      totalBooksUpdated,
    },
  };
}
