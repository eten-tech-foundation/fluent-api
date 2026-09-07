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
 * Syncs book-level audio availability for Bibles that have associated Audio
 * Bibles in DBL. For each such Bible, queries `GET /audio-bibles/{id}/books`
 * to determine which books have audio, then updates the `has_audio` flag on
 * the `bible_books` junction table.
 *
 * Delta-sync: only Bibles with `has_audio = true` are processed. Bibles
 * without any Audio Bible are skipped entirely, avoiding unnecessary API calls.
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

  const audioBibles = biblesResult.data.filter(
    (b) => b.externalId && b.provider === 'dbl' && b.hasAudio
  );

  if (audioBibles.length === 0) {
    return { ok: true, data: { totalBiblesProcessed: 0, totalBooksUpdated: 0 } };
  }

  let totalBooksUpdated = 0;
  let errorCount = 0;

  for (const bible of audioBibles) {
    if (!bible.externalId) continue;

    try {
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
      for (const audioBible of dblAudioBibles) {
        const audioBooksResult = await client.getAudioBibleBooks(audioBible.id);
        if (!audioBooksResult.ok) {
          logger.warn(
            `Failed to fetch audio books for audioBible ${audioBible.id} (text bible ${bible.externalId})`,
            { error: audioBooksResult.error }
          );
          continue; // Skip this audio bible, try others
        }
        for (const book of audioBooksResult.data) {
          audioBookCodes.add(book.id);
        }
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

  if (errorCount > 0 && errorCount === audioBibles.length) {
    logger.error('Failed to sync audio availability for all bibles', { errorCount });
    return err(ErrorCode.INTERNAL_ERROR);
  }

  return {
    ok: true,
    data: {
      totalBiblesProcessed: audioBibles.length - errorCount,
      totalBooksUpdated,
    },
  };
}
