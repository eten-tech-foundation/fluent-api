import { and, asc, count, eq, inArray } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import {
  bible_texts,
  books,
  project_unit_bible_books,
  project_units,
  projects,
  translated_verses,
} from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { BookInfo, VerseData } from './usfm.types';

const BATCH_SIZE = 25;

export async function getProjectName(projectUnitId: number): Promise<Result<string>> {
  try {
    const result = await db
      .select({ name: projects.name })
      .from(projects)
      .innerJoin(project_units, eq(projects.id, project_units.projectId))
      .where(eq(project_units.id, projectUnitId))
      .limit(1);

    if (result.length === 0) return err(ErrorCode.PROJECT_NOT_FOUND);
    return ok(result[0].name);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get project name',
      context: { projectUnitId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function validateBookIds(
  projectUnitId: number,
  bookIds?: number[]
): Promise<Result<boolean>> {
  try {
    if (!bookIds || bookIds.length === 0) {
      return ok(true);
    }

    const validBooks = await db
      .selectDistinct({ bookId: project_unit_bible_books.bookId })
      .from(project_unit_bible_books)
      .where(
        and(
          eq(project_unit_bible_books.projectUnitId, projectUnitId),
          inArray(project_unit_bible_books.bookId, bookIds)
        )
      );

    return ok(validBooks.length === bookIds.length);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to validate book IDs',
      context: { projectUnitId, bookIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getProjectBooks(
  projectUnitId: number,
  bookIds?: number[]
): Promise<Result<BookInfo[]>> {
  try {
    const query = await db
      .selectDistinct({
        bookId: project_unit_bible_books.bookId,
        bookCode: books.code,
        bookName: books.eng_display_name,
      })
      .from(project_unit_bible_books)
      .innerJoin(books, eq(project_unit_bible_books.bookId, books.id))
      .where(
        and(
          eq(project_unit_bible_books.projectUnitId, projectUnitId),
          ...(bookIds?.length ? [inArray(project_unit_bible_books.bookId, bookIds)] : [])
        )
      )
      .orderBy(asc(project_unit_bible_books.bookId));

    return ok(query);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get project books',
      context: { projectUnitId, bookIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getBookVerses(
  projectUnitId: number,
  bookIds: number[]
): Promise<Result<Map<number, VerseData[]>>> {
  try {
    if (!bookIds || bookIds.length === 0) {
      return ok(new Map());
    }

    const verses: VerseData[] = [];

    for (let i = 0; i < bookIds.length; i += BATCH_SIZE) {
      const batchBookIds = bookIds.slice(i, i + BATCH_SIZE);

      const batchVerses = await db
        .select({
          bookId: bible_texts.bookId,
          bookCode: books.code,
          bookName: books.eng_display_name,
          chapterNumber: bible_texts.chapterNumber,
          verseNumber: bible_texts.verseNumber,
          translatedContent: translated_verses.content,
        })
        .from(bible_texts)
        .innerJoin(books, eq(bible_texts.bookId, books.id))
        .innerJoin(
          project_unit_bible_books,
          and(
            eq(project_unit_bible_books.bookId, bible_texts.bookId),
            eq(project_unit_bible_books.bibleId, bible_texts.bibleId),
            eq(project_unit_bible_books.projectUnitId, projectUnitId)
          )
        )
        .leftJoin(
          translated_verses,
          and(
            eq(translated_verses.bibleTextId, bible_texts.id),
            eq(translated_verses.projectUnitId, projectUnitId)
          )
        )
        .where(
          and(
            eq(project_unit_bible_books.projectUnitId, projectUnitId),
            inArray(bible_texts.bookId, batchBookIds)
          )
        )
        .orderBy(
          asc(bible_texts.bookId),
          asc(bible_texts.chapterNumber),
          asc(bible_texts.verseNumber)
        );

      verses.push(...batchVerses);
    }

    const versesByBook = new Map<number, VerseData[]>();
    for (const verse of verses) {
      if (!versesByBook.has(verse.bookId)) {
        versesByBook.set(verse.bookId, []);
      }
      versesByBook.get(verse.bookId)!.push(verse);
    }

    return ok(versesByBook);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get book verses',
      context: { projectUnitId, bookIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getAvailableBooksForExport(projectUnitId: number) {
  try {
    const records = await db
      .select({
        bookId: project_unit_bible_books.bookId,
        bookCode: books.code,
        bookName: books.eng_display_name,
        verseCount: count(bible_texts.id).as('verse_count'),
        translatedCount: count(translated_verses.id).as('translated_count'),
      })
      .from(project_unit_bible_books)
      .innerJoin(books, eq(project_unit_bible_books.bookId, books.id))
      .innerJoin(
        bible_texts,
        and(
          eq(bible_texts.bibleId, project_unit_bible_books.bibleId),
          eq(bible_texts.bookId, project_unit_bible_books.bookId)
        )
      )
      .leftJoin(
        translated_verses,
        and(
          eq(translated_verses.bibleTextId, bible_texts.id),
          eq(translated_verses.projectUnitId, projectUnitId)
        )
      )
      .where(eq(project_unit_bible_books.projectUnitId, projectUnitId))
      .groupBy(project_unit_bible_books.bookId, books.code, books.eng_display_name)
      .orderBy(asc(project_unit_bible_books.bookId));

    return ok(records);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get available books for export',
      context: { projectUnitId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
