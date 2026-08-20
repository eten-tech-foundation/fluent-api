import type { PgBoss } from 'pg-boss';

import type { DblIngestTextJob } from '../lib/queue';

import { db } from '../db';
import { bible_texts } from '../db/schema';
import { logger } from '../lib/logger';
import { QUEUE_NAMES } from '../lib/queue';
import { dblClient } from '../lib/services/dbl/dbl.client';

/**
 * Registers the on-demand Bible text ingestion worker with pg-boss.
 *
 * This worker handles two queues with the same handler:
 * - `DBL_INGEST_TEXT_PRIORITY`: Processes the specific books a user requested
 *   when creating a project. Uses pg-boss priority=10 so these run first.
 * - `DBL_INGEST_TEXT`: Processes the remaining books in the Bible as a
 *   background prefetch for future projects.
 *
 * Error handling:
 * - Per-chapter isolation: if a single chapter fails to download, the worker
 *   logs the error and continues to the next chapter. This prevents a
 *   transient network blip from aborting an entire book.
 * - Missing Bible or book records cause the job to throw, which pg-boss
 *   routes to its retry/dead-letter machinery.
 *
 * Idempotency:
 * - Verse inserts use `onConflictDoNothing()` keyed on the composite unique
 *   index (bible_id, book_id, chapter_number, verse_number). Re-running the
 *   same job for already-ingested content is a harmless no-op.
 */
export async function registerDblIngestTextWorker(boss: PgBoss) {
  const handler = async (
    jobs: { id?: string; data: DblIngestTextJob }[] | { id?: string; data: DblIngestTextJob }
  ) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    const { bibleId, bookCodes } = job.data;
    logger.info(`Starting on-demand text ingestion (Job ID: ${job.id})`, { bibleId, bookCodes });

    // Resolve the internal Bible record to get its DBL externalId.
    const bible = await db.query.bibles.findFirst({
      where: (bibles, { eq }) => eq(bibles.id, bibleId),
    });

    if (!bible || !bible.externalId) {
      throw new Error(`Bible not found or missing externalId for bibleId: ${bibleId}`);
    }
    const externalId = bible.externalId;

    for (const code of bookCodes) {
      logger.info(`Fetching chapters for book ${code}`);

      // Resolve the book's internal ID from its canonical code (e.g. "GEN").
      const dbBook = await db.query.books.findFirst({
        where: (books, { eq }) => eq(books.code, code),
      });
      if (!dbBook) continue;

      const chaptersResult = await dblClient.getChapters(externalId, code);
      if (!chaptersResult.ok) {
        logger.error(`Failed to fetch chapters for book ${code}`, { error: chaptersResult.error });
        continue;
      }
      const chapters = chaptersResult.data;

      for (const chapter of chapters) {
        // API.Bible returns an 'intro' pseudo-chapter for some Bibles;
        // skip it since it contains no verse data.
        if (chapter.number === 'intro') continue;

        try {
          const versesResult = await dblClient.getVerses(externalId, chapter.id);
          if (!versesResult.ok) {
            throw new Error(`Failed to fetch verses: ${versesResult.error.message}`);
          }
          const verseMetadata = versesResult.data;

          const values: any[] = [];

          // Fetch the actual text for each verse in parallel (batched if necessary, but chapters are small enough)
          const versePromises = verseMetadata.map(async (v) => {
            const textResult = await dblClient.getVerse(externalId, v.id, { contentType: 'text' });

            let text = '';
            if (textResult.ok && typeof textResult.data.content === 'string') {
              text = textResult.data.content;
            }

            const parts = v.id.split('.');
            const verseNumber = parts.length === 3 ? Number.parseInt(parts[2], 10) : 0;

            return {
              bibleId,
              bookId: dbBook.id,
              chapterNumber: Number.parseInt(chapter.number, 10) || 0,
              verseNumber,
              text: text || '', // Fallback to empty string if API omits text
            };
          });

          values.push(...(await Promise.all(versePromises)));

          if (values.length > 0) {
            // Idempotent insert: duplicate (bible, book, chapter, verse) tuples
            // are silently skipped via the composite unique index.
            await db.insert(bible_texts).values(values).onConflictDoNothing();
          }
        } catch (error) {
          // Per-chapter error isolation: log and continue to the next chapter
          // so a single transient failure doesn't abort the entire book.
          logger.error(`Error ingesting chapter ${chapter.id}`, { error });
        }
      }
    }

    logger.info('On-demand text ingestion completed', { bibleId });
  };

  // Register the same handler on both queues. pg-boss processes the priority
  // queue first due to the priority=10 value set during job creation.
  await boss.work<DblIngestTextJob>(QUEUE_NAMES.DBL_INGEST_TEXT, handler);
  await boss.work<DblIngestTextJob>(QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY, handler);

  logger.info(
    `Registered workers for queues: ${QUEUE_NAMES.DBL_INGEST_TEXT} and ${QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY}`
  );
}
