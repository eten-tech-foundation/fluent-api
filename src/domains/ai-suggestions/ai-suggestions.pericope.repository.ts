import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

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
 * True when the project family holds exactly `threshold` drafted verses, which is the state right
 * after the save that crossed the activation threshold. Same family scope as
 * hasReachedAiActivationThreshold; the difference is asking for one more row than the threshold
 * and checking that it is not there.
 */
export async function isExactlyAtAiActivationThreshold(
  projectUnitId: number,
  threshold: number
): Promise<boolean> {
  const [projectInfo] = await db
    .select({
      sourceLanguage: projects.sourceLanguage,
      targetLanguage: projects.targetLanguage,
      organization: projects.organization,
    })
    .from(project_units)
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .where(eq(project_units.id, projectUnitId))
    .limit(1);

  if (!projectInfo) return false;

  const rows = await db
    .select({ id: translated_verses.id })
    .from(translated_verses)
    .innerJoin(project_units, eq(translated_verses.projectUnitId, project_units.id))
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .where(
      and(
        eq(projects.sourceLanguage, projectInfo.sourceLanguage),
        eq(projects.targetLanguage, projectInfo.targetLanguage),
        eq(projects.organization, projectInfo.organization),
        sql`length(trim(${translated_verses.content})) > 0`
      )
    )
    .limit(2)
    .offset(threshold - 1);

  return rows.length === 1;
}
