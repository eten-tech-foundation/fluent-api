import { and, eq, exists, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { db } from '@/db';
import { books, pericope_sets, pericope_verses, projects } from '@/db/schema';

export async function getAllPericopeSets() {
  return db
    .select({
      id: pericope_sets.id,
      name: pericope_sets.name,
      description: pericope_sets.description,
    })
    .from(pericope_sets)
    .orderBy(pericope_sets.name);
}

export async function getPericopeSetById(id: number) {
  const [set] = await db
    .select({
      id: pericope_sets.id,
      name: pericope_sets.name,
      description: pericope_sets.description,
    })
    .from(pericope_sets)
    .where(eq(pericope_sets.id, id))
    .limit(1);
  return set ?? null;
}

export async function getPericopeVersesForSet(pericopeSetId: number, bookId?: number) {
  return db
    .select({
      bookId: pericope_verses.bookId,
      bookCode: books.code,
      chapterNumber: pericope_verses.chapterNumber,
      verseNumber: pericope_verses.verseNumber,
      section: pericope_verses.section,
      pericopeNumber: pericope_verses.pericopeNumber,
      pericopeTitle: pericope_verses.pericopeTitle,
    })
    .from(pericope_verses)
    .innerJoin(books, eq(books.id, pericope_verses.bookId))
    .where(
      and(
        eq(pericope_verses.pericopeSetId, pericopeSetId),
        bookId === undefined ? undefined : eq(pericope_verses.bookId, bookId)
      )
    )
    .orderBy(pericope_verses.bookId, pericope_verses.chapterNumber, pericope_verses.verseNumber);
}

export async function getPericopeSetIdForProject(projectId: number): Promise<number | null> {
  const [project] = await db
    .select({ pericopeSetId: projects.pericopeSetId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return project?.pericopeSetId ?? null;
}

export async function getBookIdByCode(bookCode: string): Promise<number | null> {
  const [book] = await db
    .select({ id: books.id })
    .from(books)
    .where(eq(books.code, bookCode.trim().toUpperCase()))
    .limit(1);
  return book?.id ?? null;
}

export async function getPericopeVersesForChapter(
  pericopeSetId: number,
  bookId: number,
  chapterNumber: number,
  includeFullPericopes = false
) {
  const chapterVerses = alias(pericope_verses, 'chapter_verses');
  // Select groups intersecting the requested chapter before expanding their
  // references. FCBH numbers repeat per section; FIA sections are null.
  const chapterFilter = includeFullPericopes
    ? exists(
        db
          .select({ id: chapterVerses.id })
          .from(chapterVerses)
          .where(
            and(
              eq(chapterVerses.pericopeSetId, pericopeSetId),
              eq(chapterVerses.bookId, bookId),
              eq(chapterVerses.chapterNumber, chapterNumber),
              eq(chapterVerses.pericopeNumber, pericope_verses.pericopeNumber),
              or(
                and(isNull(chapterVerses.section), isNull(pericope_verses.section)),
                eq(chapterVerses.section, pericope_verses.section)
              )
            )
          )
      )
    : eq(pericope_verses.chapterNumber, chapterNumber);

  return db
    .select({
      chapterNumber: pericope_verses.chapterNumber,
      verseNumber: pericope_verses.verseNumber,
      section: pericope_verses.section,
      pericopeNumber: pericope_verses.pericopeNumber,
      pericopeTitle: pericope_verses.pericopeTitle,
    })
    .from(pericope_verses)
    .where(
      and(
        eq(pericope_verses.pericopeSetId, pericopeSetId),
        eq(pericope_verses.bookId, bookId),
        chapterFilter
      )
    )
    .orderBy(pericope_verses.chapterNumber, pericope_verses.verseNumber);
}
