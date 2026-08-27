import type { PgBoss } from 'pg-boss';

import { sql } from 'drizzle-orm';

import type { DblIngestTextJob } from '../lib/queue';
import type { WorkerMetricsHooks } from './usfm-export.worker';

import { db } from '../db';
import { bible_texts, project_units } from '../db/schema';
import * as chapterAssignmentsService from '../domains/chapter-assignments/chapter-assignments.service';
import { logger } from '../lib/logger';
import { QUEUE_NAMES } from '../lib/queue';
import { dblClient } from '../lib/services/dbl/dbl.client';
import { extractVersesFromText } from '../lib/services/dbl/dbl.parser';

// ─── Worker ────────────────────────────────────────────────────────────────

/**
 * Ingests Bible text from API.Bible (DBL) via pg-boss jobs.
 *
 * We fetch full chapters as plain text and parse verses via regex to avoid API rate limits
 * (~1,189 calls vs ~31,000 calls per Bible).
 *
 * Failed chapters are skipped to isolate errors, and upserts are idempotent
 * based on the unique index: (bible_id, book_id, chapter_number, verse_number).
 */
export async function registerDblIngestTextWorker(boss: PgBoss, metricsHooks?: WorkerMetricsHooks) {
  const handler = async (jobs: { id?: string; data: DblIngestTextJob }[]) => {
    const startTime = Date.now();
    metricsHooks?.onBatchStart?.(jobs.length);

    try {
      const job = jobs[0];
      let jobFailedChapters = 0;
      const { bibleId, bookCodes } = job.data;
      logger.info(`Starting on-demand text ingestion (Job ID: ${job.id})`, {
        bibleId,
        bookCodes,
      });

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

        if (!dbBook) {
          logger.warn(`Book code "${code}" not found in database, skipping`, { bibleId });
          continue;
        }

        const chaptersResult = await dblClient.getChapters(externalId, code);
        if (!chaptersResult.ok) {
          logger.error(`Failed to fetch chapters for book ${code}`, {
            error: chaptersResult.error,
          });
          jobFailedChapters++;
          continue;
        }
        const chapters = chaptersResult.data;

        for (const chapter of chapters) {
          // API.Bible returns an 'intro' pseudo-chapter for some Bibles;
          // skip it since it contains no verse data.
          if (chapter.number === 'intro') continue;

          const chapterNumber = Number.parseInt(chapter.number ?? '', 10);
          if (!chapterNumber || chapterNumber <= 0) {
            logger.warn(`Skipping chapter with unparseable number: ${chapter.number}`, {
              chapterId: chapter.id,
            });
            continue;
          }

          try {
            // Fetch chapter as plain text with verse markers (e.g. "[1] ")
            const chapterResult = await dblClient.getChapter(externalId, chapter.id, {
              contentType: 'text',
              includeNotes: false,
              includeTitles: false,
              includeChapterNumbers: false,
              includeVerseNumbers: true,
            });

            if (!chapterResult.ok) {
              logger.warn(`Failed to fetch chapter ${chapter.id}`, {
                error: chapterResult.error,
              });
              jobFailedChapters++;
              continue;
            }

            // Parse text into Map<verseNumber, text>
            const verseTexts = extractVersesFromText(
              String(chapterResult.data.content),
              chapterResult.data.verseCount ?? undefined
            );

            const values: Array<{
              bibleId: number;
              bookId: number;
              chapterNumber: number;
              verseNumber: number;
              text: string;
            }> = [];

            for (const [verseNumber, text] of verseTexts) {
              values.push({
                bibleId,
                bookId: dbBook.id,
                chapterNumber,
                verseNumber,
                text,
              });
            }

            if (values.length > 0) {
              await db
                .insert(bible_texts)
                .values(values)
                .onConflictDoUpdate({
                  target: [
                    bible_texts.bibleId,
                    bible_texts.bookId,
                    bible_texts.chapterNumber,
                    bible_texts.verseNumber,
                  ],
                  set: {
                    text: sql`excluded.text`,
                  },
                });
              logger.info(
                `Ingested chapter ${chapter.number} (${values.length} verses) for book ${code}`
              );
            }
          } catch (error) {
            // Log and continue so a single failed chapter doesn't crash the book sync
            logger.error(`Error ingesting chapter ${chapter.id}`, { error });
            jobFailedChapters++;
          }
        }
      }

      logger.info('On-demand text ingestion completed', { bibleId });

      if (jobFailedChapters > 0) {
        throw new Error(
          `Job failed to ingest ${jobFailedChapters} chapters. Throwing to trigger retry.`
        );
      }

      // Once text ingestion completes, ensure chapter assignments exist for the project unit
      if (job.data.projectId && bookCodes.length > 0) {
        try {
          const projectUnits = await db
            .select({ id: project_units.id })
            .from(project_units)
            .where(sql`${project_units.projectId} = ${job.data.projectId}`);

          const bookIds = await db.query.books
            .findMany({
              where: (books, { inArray }) => inArray(books.code, bookCodes),
            })
            .then((res) => res.map((b) => b.id));

          let failedAssignments = 0;

          for (const pu of projectUnits) {
            if (bookIds.length > 0) {
              const assignmentResult =
                await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
                  pu.id,
                  bibleId,
                  bookIds
                );

              if (assignmentResult.ok) {
                logger.info('Created chapter assignments for project unit after text ingestion', {
                  projectId: job.data.projectId,
                  projectUnitId: pu.id,
                  bookIds,
                });
              } else {
                failedAssignments++;
                logger.error('Failed to create chapter assignments for project unit', {
                  projectId: job.data.projectId,
                  projectUnitId: pu.id,
                  bookIds,
                  error: assignmentResult.error,
                });
              }
            }
          }

          if (failedAssignments > 0) {
            throw new Error(
              `Failed to create chapter assignments for ${failedAssignments} project unit(s). Throwing to trigger retry.`
            );
          }
        } catch (error) {
          logger.error('Failed to create chapter assignments after text ingestion', { error });
          throw error;
        }
      }

      metricsHooks?.onJobSuccess?.(Date.now() - startTime);
    } catch (error) {
      metricsHooks?.onJobFailure?.(Date.now() - startTime);
      throw error; // Re-throw so pg-boss retries the job
    } finally {
      metricsHooks?.onBatchEnd?.(jobs.length);
    }
  };

  // Register handler on both queues; priority queue processes first
  await boss.createQueue(QUEUE_NAMES.DBL_INGEST_TEXT);
  await boss.createQueue(QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY);

  const workOptions = { batchSize: 1 };
  await boss.work<DblIngestTextJob>(QUEUE_NAMES.DBL_INGEST_TEXT, workOptions, handler);
  await boss.work<DblIngestTextJob>(QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY, workOptions, handler);

  logger.info(
    `Registered workers for queues: ${QUEUE_NAMES.DBL_INGEST_TEXT} and ${QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY}`
  );
}
