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
  errorCount: number;
  partialFailure: boolean;
}

/**
 * Fetches books for every Bible currently in the database and upserts/links
 * them. API requests are batched concurrently (chunks of 20) for speed, while
 * database writes are performed sequentially to avoid connection pool exhaustion
 * and row lock contention on the shared `books` table.
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
  let processedCount = 0;
  const chunkSize = 20;

  for (let i = 0; i < dbBibles.length; i += chunkSize) {
    const chunk = dbBibles.slice(i, i + chunkSize);

    // 1. FETCH CONCURRENTLY — fast over high-latency networks
    const fetchResults = await Promise.all(
      chunk.map(async (bible) => {
        if (!bible.externalId) return { bible, books: null, error: false } as const;

        try {
          const booksResult = await client.getBooks(bible.externalId);
          if (!booksResult.ok) {
            logger.error(
              `Failed to fetch books from DBL for bible ${bible.externalId}: ${booksResult.error.message}`
            );
            return { bible, books: null, error: true } as const;
          }

          const rows: DblBookUpsertInput[] = booksResult.data.map((b) => ({
            code: b.id,
            eng_display_name: b.name || b.nameLong || b.id,
          }));

          return { bible, books: rows, error: false } as const;
        } catch (error) {
          logger.error(`Unexpected error fetching books for bible ${bible.externalId}`, { error });
          return { bible, books: null, error: true } as const;
        }
      })
    );

    // 2. WRITE SEQUENTIALLY — avoids connection pool exhaustion and row lock contention
    for (const result of fetchResults) {
      if (result.error) {
        errorCount++;
        continue;
      }
      if (!result.books) continue;

      try {
        const upsertResult = await booksRepository.upsertFromDbl(result.bible.id, result.books);
        if (!upsertResult.ok) {
          errorCount++;
          continue;
        }
        totalBooksLinked += upsertResult.data.linkedBooks;
      } catch (error) {
        errorCount++;
        logger.error(`Unexpected error upserting books for bible ${result.bible.externalId}`, {
          error,
        });
      }
    }

    processedCount += chunk.length;
    logger.info(`Synced books for ${processedCount}/${dbBibles.length} bibles...`);
  }

  // We could return a partial success/error, but returning ok if we processed *some* is standard for background syncs.
  // We'll log the error count.
  if (errorCount > 0 && errorCount === dbBibles.length) {
    // Every single Bible failed — treat as a total failure.
    logger.error('Failed to sync books for all bibles', { errorCount });
    return err(ErrorCode.INTERNAL_ERROR);
  }

  if (errorCount > 0) {
    logger.warn('Completed book sync with partial failures', {
      errorCount,
      totalBibles: dbBibles.length,
    });
  }

  return {
    ok: true,
    data: {
      totalBiblesProcessed: dbBibles.length - errorCount,
      totalBooksLinked,
      errorCount,
      partialFailure: errorCount > 0,
    },
  };
}

// ─── Audio availability sync ────────────────────────────────────────────────

export interface AudioAvailabilitySyncSummary {
  totalBiblesProcessed: number;
  totalBooksUpdated: number;
  errorCount: number;
  partialFailure: boolean;
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
    return {
      ok: true,
      data: { totalBiblesProcessed: 0, totalBooksUpdated: 0, errorCount: 0, partialFailure: false },
    };
  }

  let totalBooksUpdated = 0;
  let errorCount = 0;
  let processedCount = 0;
  const chunkSize = 20;

  for (let i = 0; i < dblBibles.length; i += chunkSize) {
    const chunk = dblBibles.slice(i, i + chunkSize);

    // 1. FETCH CONCURRENTLY — gather audio book codes from the DBL API
    const fetchResults = await Promise.all(
      chunk.map(async (bible) => {
        if (!bible.externalId)
          return { bible, audioBookCodes: null, clearAudio: false, error: false } as const;

        // Fast-path: Bibles without audio need no network call, just a DB clear
        if (!bible.hasAudio) {
          return { bible, audioBookCodes: null, clearAudio: true, error: false } as const;
        }

        try {
          // Fetch the full Bible metadata from DBL to get audioBible IDs
          const dblBibleResult = await client.getBible(bible.externalId);
          if (!dblBibleResult.ok) {
            logger.error(`Failed to fetch DBL Bible metadata for audio sync: ${bible.externalId}`, {
              error: dblBibleResult.error,
            });
            return { bible, audioBookCodes: null, clearAudio: false, error: true } as const;
          }

          const dblAudioBibles = dblBibleResult.data.audioBibles;
          if (!dblAudioBibles || dblAudioBibles.length === 0) {
            return { bible, audioBookCodes: null, clearAudio: false, error: false } as const;
          }

          // Collect audio book codes from all associated Audio Bibles
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
            return { bible, audioBookCodes: null, clearAudio: false, error: true } as const;
          }

          return {
            bible,
            audioBookCodes: [...audioBookCodes],
            clearAudio: false,
            error: false,
          } as const;
        } catch (error) {
          logger.error(
            `Unexpected error fetching audio availability for bible ${bible.externalId}`,
            {
              error,
            }
          );
          return { bible, audioBookCodes: null, clearAudio: false, error: true } as const;
        }
      })
    );

    // 2. WRITE SEQUENTIALLY — avoids connection pool exhaustion and row lock contention
    for (const result of fetchResults) {
      if (result.error) {
        errorCount++;
        continue;
      }

      try {
        if (result.clearAudio) {
          // Clear audio availability for non-audio bibles
          const updateResult = await booksRepository.updateAudioAvailability(result.bible.id, []);
          if (!updateResult.ok) {
            errorCount++;
          } else {
            totalBooksUpdated += updateResult.data.updated;
          }
          continue;
        }

        if (!result.audioBookCodes) continue;

        const updateResult = await booksRepository.updateAudioAvailability(result.bible.id, [
          ...result.audioBookCodes,
        ]);
        if (!updateResult.ok) {
          errorCount++;
          continue;
        }

        totalBooksUpdated += updateResult.data.updated;
      } catch (error) {
        errorCount++;
        logger.error(
          `Unexpected error updating audio availability for bible ${result.bible.externalId}`,
          { error }
        );
      }
    }

    processedCount += chunk.length;
    logger.info(`Synced audio availability for ${processedCount}/${dblBibles.length} bibles...`);
  }

  if (errorCount > 0 && errorCount === dblBibles.length) {
    logger.error('Failed to sync audio availability for all bibles', { errorCount });
    return err(ErrorCode.INTERNAL_ERROR);
  }

  if (errorCount > 0) {
    logger.warn('Completed audio availability sync with partial failures', {
      errorCount,
      totalBibles: dblBibles.length,
    });
  }

  return {
    ok: true,
    data: {
      totalBiblesProcessed: dblBibles.length - errorCount,
      totalBooksUpdated,
      errorCount,
      partialFailure: errorCount > 0,
    },
  };
}
