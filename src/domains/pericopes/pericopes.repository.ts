import { and, eq } from 'drizzle-orm';

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
  chapterNumber: number
) {
  return db
    .select({
      chapterNumber: pericope_verses.chapterNumber,
      verseNumber: pericope_verses.verseNumber,
      pericopeNumber: pericope_verses.pericopeNumber,
      pericopeTitle: pericope_verses.pericopeTitle,
    })
    .from(pericope_verses)
    .where(
      and(
        eq(pericope_verses.pericopeSetId, pericopeSetId),
        eq(pericope_verses.bookId, bookId),
        eq(pericope_verses.chapterNumber, chapterNumber)
      )
    )
    .orderBy(pericope_verses.verseNumber);
}
