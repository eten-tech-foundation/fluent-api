import { db } from '../db';
import { bible_books, bibles, books, languages } from '../db/schema';
import { DblClient } from '../lib/dbl/client';
import { logger } from '../lib/logger';

/**
 * Fetches all open-license Bibles from the DBL (API.Bible) catalogue and
 * upserts them into Fluent's local database.
 *
 * This function is called by the weekly `dbl-sync` cron worker to keep the
 * lookup tables (languages, bibles, books, bible_books) in sync with the
 * upstream catalogue.
 *
 * Design decisions:
 * - **Provider Precedence:** DBL is treated as the authoritative source.
 *   Language and Bible records are upserted with `onConflictDoUpdate`.
 * - **Per-Bible isolation:** Each Bible is processed inside its own try/catch
 *   so a single network failure doesn't abort the remaining catalogue.
 * - **Book name safety:** The global `books` table stores canonical English
 *   display names. We use `onConflictDoNothing` for book inserts to preserve
 *   the first-seen English name and prevent localized names (e.g. "Génesis")
 *   from overwriting it.
 * - **Open-license filtering:** As a secondary safeguard, Bibles whose `info`
 *   metadata contains "restricted" or "commercial" are explicitly skipped.
 *
 * Errors are intentionally NOT caught at the top level — they propagate to
 * the pg-boss worker so failed jobs are correctly marked as failures and
 * retried by the dead-letter machinery.
 */
export async function ingestDblBibles() {
  const client = new DblClient();
  logger.info('Fetching open-license Bibles from DBL...');

  const allBibles = await client.getBibles();

  // API.Bible doesn't expose a strict 'is_open_license' flag in the summary
  // response. Our API key tier should inherently restrict to open-license
  // content, but we apply an additional keyword filter below as a safeguard.
  const openBibles = allBibles;

  logger.info(`Found ${openBibles.length} Bibles. Upserting into database...`);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const bible of openBibles) {
    // Skip Bibles with missing language metadata — we can't create a
    // meaningful language record without it.
    if (!bible.language) {
      skipCount++;
      continue;
    }

    // Secondary open-license filter: skip any Bibles whose `info` metadata
    // explicitly flags them as restricted or commercial use only.
    if (
      bible.info?.toLowerCase().includes('restricted') ||
      bible.info?.toLowerCase().includes('commercial')
    ) {
      logger.info(`Skipping restricted-license Bible: ${bible.abbreviation}`);
      skipCount++;
      continue;
    }

    try {
      // ── Step 1: Upsert Language ──────────────────────────────────────
      // Uses the ISO 639-3 code as the conflict target. If the language
      // already exists, we refresh its name/localized name from DBL.
      const langResult = await db
        .insert(languages)
        .values({
          langName: bible.language.name,
          langNameLocalized: bible.language.nameLocal,
          langCodeIso6393: bible.language.id.toLowerCase().slice(0, 3),
          scriptDirection: bible.language.scriptDirection === 'RTL' ? 'rtl' : 'ltr',
        })
        .onConflictDoUpdate({
          target: languages.langCodeIso6393,
          set: {
            langName: bible.language.name,
            langNameLocalized: bible.language.nameLocal,
          },
        })
        .returning({ id: languages.id });

      const languageId = langResult[0].id;

      // ── Step 2: Upsert Bible ─────────────────────────────────────────
      // On conflict we overwrite name, provider, and externalId so DBL
      // always remains the authoritative record.
      const bibleResult = await db
        .insert(bibles)
        .values({
          languageId,
          name: bible.name,
          abbreviation: bible.abbreviationLocal || bible.abbreviation,
          provider: 'dbl',
          externalId: bible.id,
        })
        .onConflictDoUpdate({
          target: bibles.abbreviation,
          set: {
            name: bible.name,
            languageId, // Also update the language association
            provider: 'dbl',
            externalId: bible.id,
          },
        })
        .returning({ id: bibles.id });

      const dbBibleId = bibleResult[0].id;

      // ── Step 3: Fetch and Link Books ─────────────────────────────────
      logger.info(`Fetching books for Bible: ${bible.name} (${bible.id})`);
      const bibleBooks = await client.getBooks(bible.id);

      for (const dblBook of bibleBooks) {
        // Insert into the global `books` reference table. We use
        // onConflictDoNothing to preserve the first-seen English display
        // name and avoid localized names from non-English Bibles
        // overwriting it (e.g. "Génesis" replacing "Genesis").
        const bookResult = await db
          .insert(books)
          .values({
            code: dblBook.id,
            eng_display_name: dblBook.name,
          })
          .onConflictDoNothing()
          .returning({ id: books.id });

        // If onConflictDoNothing skipped the insert, we need to look up
        // the existing book ID by its code.
        let bookId: number;
        if (bookResult.length > 0) {
          bookId = bookResult[0].id;
        } else {
          const existing = await db.query.books.findFirst({
            where: (books, { eq }) => eq(books.code, dblBook.id),
          });
          if (!existing) continue;
          bookId = existing.id;
        }

        // Link the book to this Bible via the junction table.
        // onConflictDoNothing requires a unique constraint on
        // (bible_id, book_id) — see schema.ts.
        await db
          .insert(bible_books)
          .values({
            bibleId: dbBibleId,
            bookId,
          })
          .onConflictDoNothing();
      }

      successCount++;
    } catch (error) {
      // Per-Bible error isolation: log the failure and continue with
      // the next Bible so one bad entry doesn't abort the entire sync.
      errorCount++;
      logger.error(`Error ingesting Bible: ${bible.abbreviation} (${bible.id})`, { error });
    }
  }

  logger.info(
    `Finished ingesting DBL Bibles. Success: ${successCount}, Skipped: ${skipCount}, Errors: ${errorCount}`
  );

  // If every single attempted Bible errored, throw so pg-boss marks the job
  // as failed and the dead-letter/retry machinery kicks in. We only throw
  // if actual errors occurred (ignoring cases where everything was skipped).
  if (successCount === 0 && errorCount > 0) {
    throw new Error(
      `DBL ingestion failed for all ${openBibles.length} Bibles (${errorCount} errors, ${skipCount} skipped)`
    );
  }
}
