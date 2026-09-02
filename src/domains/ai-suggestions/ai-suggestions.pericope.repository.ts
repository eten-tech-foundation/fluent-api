import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import { ai_suggestions, bible_texts, books, project_units, translated_verses } from '@/db/schema';

import { MAX_QUEUED_VERSES_PER_CALL } from './ai-suggestions.constants';
import {
  familyHasReachedAiActivationThreshold,
  getAiActivationFamily,
} from './ai-suggestions.repository';

// ─── Pericope-level queuing (#417) ────────────────────────────────────────────

/** The project a unit belongs to, so the pericopes domain can be asked for its grouping. */
export async function getProjectIdForProjectUnit(projectUnitId: number): Promise<number | null> {
  const [unit] = await db
    .select({ projectId: project_units.projectId })
    .from(project_units)
    .where(eq(project_units.id, projectUnitId))
    .limit(1);
  return unit?.projectId ?? null;
}

/**
 * Which of the given verses still need a suggestion: no saved draft for this project unit, and no
 * suggestion already generated. The second filter is what keeps re-navigating a pericope from
 * regenerating text the translator already has.
 */
export async function findVersesNeedingSuggestions(
  projectUnitId: number,
  bibleId: number,
  bookCode: string,
  chapterNumber: number,
  verseNumbers: number[]
): Promise<number[]> {
  if (verseNumbers.length === 0) return [];

  // The cap has to land before the query is built: LIMIT bounds the rows that come back, not
  // the IN list a malformed pericope group could hand the planner.
  const wanted = verseNumbers.slice(0, MAX_QUEUED_VERSES_PER_CALL);

  const rows = await db
    .select({ verseNumber: bible_texts.verseNumber })
    .from(bible_texts)
    .innerJoin(books, eq(bible_texts.bookId, books.id))
    .leftJoin(
      translated_verses,
      and(
        eq(translated_verses.bibleTextId, bible_texts.id),
        eq(translated_verses.projectUnitId, projectUnitId)
      )
    )
    .leftJoin(
      ai_suggestions,
      and(
        eq(ai_suggestions.bibleTextId, bible_texts.id),
        eq(ai_suggestions.projectUnitId, projectUnitId)
      )
    )
    .where(
      and(
        eq(bible_texts.bibleId, bibleId),
        eq(books.code, bookCode),
        eq(bible_texts.chapterNumber, chapterNumber),
        inArray(bible_texts.verseNumber, wanted),
        isNull(translated_verses.projectUnitId),
        isNull(ai_suggestions.projectUnitId)
      )
    )
    .orderBy(asc(bible_texts.verseNumber))
    .limit(MAX_QUEUED_VERSES_PER_CALL);

  return rows.map((r) => r.verseNumber);
}

/** Where a bible_texts row sits, so a saved verse can be turned back into its chapter. */
export async function getBibleTextLocation(
  bibleTextId: number
): Promise<{ bibleId: number; bookCode: string; chapterNumber: number } | null> {
  const [row] = await db
    .select({
      bibleId: bible_texts.bibleId,
      bookCode: books.code,
      chapterNumber: bible_texts.chapterNumber,
    })
    .from(bible_texts)
    .innerJoin(books, eq(bible_texts.bookId, books.id))
    .where(eq(bible_texts.id, bibleTextId))
    .limit(1);

  return row ?? null;
}

/**
 * Runs a draft save and reports whether that save is the one that took the project family over the
 * AI activation threshold. Exactly one save ever gets `crossed: true` for a given crossing.
 *
 * Counting after the fact cannot answer this. Two saves committing from 499 both observe 501
 * afterwards and both conclude they were not the crossing one, so the backfill is skipped for
 * good; and every later edit of an already-activated family observes the threshold again and
 * re-fires it. So the transition is claimed instead of measured, under a family-scoped advisory
 * lock held for the rest of the save transaction:
 *
 *   A and B both save while the family sits at 499. A takes the lock, measures before = false,
 *   writes (500), measures after = true, and claims the crossing. B blocks on the lock until A
 *   commits, then measures before = true, so it does not claim it. An edit made later, with the
 *   family already at 500, also sees before = true and claims nothing.
 *
 * `after` has to be measured on `tx`: the row `write` just inserted is invisible to every other
 * connection until this transaction commits. The lock is transaction-scoped, so it is released on
 * commit or rollback with no unlock call to leak.
 */
export async function claimAiActivationCrossing<T>(
  tx: DbTransaction,
  projectUnitId: number,
  threshold: number,
  write: () => Promise<Result<T>>
): Promise<{ written: Result<T>; crossed: boolean }> {
  // The family cannot change mid-transaction, so it is read once and threaded through every
  // measurement rather than re-fetched inside each one.
  const family = await getAiActivationFamily(projectUnitId, tx);

  // A family already over the threshold cannot be crossing it now, so the common case skips the
  // lock entirely rather than serialising every save in an active organisation behind it.
  if (!family || (await familyHasReachedAiActivationThreshold(family, threshold, tx))) {
    return { written: await write(), crossed: false };
  }

  // Two real integer keys rather than a hash of the triple, so unrelated organisations can never
  // collide onto one lock. Families in the same organisation with the same source language share
  // a key; they serialise briefly but the counts stay scoped by the full triple in the WHERE.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${family.organization}::int, ${family.sourceLanguage}::int)`
  );

  // Re-measured under the lock: another save may have committed while this one waited for it.
  const before = await familyHasReachedAiActivationThreshold(family, threshold, tx);
  const written = await write();

  // A failed write leaves the transaction aborted, so nothing more may run on it; and if the
  // family was already over before this write, it cannot have crossed, so `after` is not needed.
  if (!written.ok || before) return { written, crossed: false };

  const after = await familyHasReachedAiActivationThreshold(family, threshold, tx);
  return { written, crossed: after };
}
