import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import {
  ai_suggestions,
  bible_texts,
  books,
  pericope_verses,
  project_units,
  projects,
  translated_verses,
} from '@/db/schema';

import {
  getAiActivationFamily,
  hasReachedAiActivationThreshold,
} from './ai-suggestions.repository';

// ─── Pericope-level queuing (#417) ────────────────────────────────────────────

/**
 * The verse numbers of every pericope in a chapter, in reading order, one array per pericope.
 * Empty when the project has no pericope set or the set does not cover this chapter, which is
 * the verse-by-verse fallback the pericope view itself uses.
 */
export async function getChapterPericopeVerseGroups(
  projectUnitId: number,
  bookCode: string,
  chapterNumber: number
): Promise<number[][]> {
  const [unit] = await db
    .select({ pericopeSetId: projects.pericopeSetId })
    .from(project_units)
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .where(eq(project_units.id, projectUnitId))
    .limit(1);

  if (!unit?.pericopeSetId) return [];

  const rows = await db
    .select({
      verseNumber: pericope_verses.verseNumber,
      section: pericope_verses.section,
      pericopeNumber: pericope_verses.pericopeNumber,
    })
    .from(pericope_verses)
    .innerJoin(books, eq(pericope_verses.bookId, books.id))
    .where(
      and(
        eq(pericope_verses.pericopeSetId, unit.pericopeSetId),
        eq(books.code, bookCode.toUpperCase()),
        eq(pericope_verses.chapterNumber, chapterNumber)
      )
    )
    .orderBy(asc(pericope_verses.verseNumber));

  // Same grouping the pericopes domain applies: FCBH sets carry a section, FIA does not.
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const key = row.section !== null ? `${row.section}_${row.pericopeNumber}` : row.pericopeNumber;
    const verses = groups.get(key) ?? [];
    verses.push(row.verseNumber);
    groups.set(key, verses);
  }
  return Array.from(groups.values());
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
        inArray(bible_texts.verseNumber, verseNumbers),
        isNull(translated_verses.projectUnitId),
        isNull(ai_suggestions.projectUnitId)
      )
    )
    .orderBy(asc(bible_texts.verseNumber));

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
  // A family already over the threshold cannot be crossing it now, so the common case skips the
  // lock entirely rather than serialising every save in an active organisation behind it.
  const family = await getAiActivationFamily(projectUnitId, tx);
  if (!family || (await hasReachedAiActivationThreshold(projectUnitId, threshold, tx))) {
    return { written: await write(), crossed: false };
  }

  const lockKey = `ai-activation:${family.sourceLanguage}:${family.targetLanguage}:${family.organization}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`);

  // Re-measured under the lock: another save may have committed while this one waited for it.
  const before = await hasReachedAiActivationThreshold(projectUnitId, threshold, tx);
  const written = await write();

  // A failed write leaves the transaction aborted, so nothing more may run on it.
  if (!written.ok) return { written, crossed: false };

  const after = await hasReachedAiActivationThreshold(projectUnitId, threshold, tx);

  return { written, crossed: !before && after };
}
