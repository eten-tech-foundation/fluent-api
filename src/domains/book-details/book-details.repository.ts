import { and, asc, eq } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { books, project_unit_bible_books } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { BookDetails, UpdateBookDetailsInput } from './book-details.types';

export async function list(projectUnitId: number): Promise<Result<BookDetails[]>> {
  try {
    const rows = await db
      .selectDistinct({
        bookId: project_unit_bible_books.bookId,
        bookCode: books.code,
        bookName: books.eng_display_name,
        runningHeader: project_unit_bible_books.runningHeader,
        bookTitle: project_unit_bible_books.bookTitle,
      })
      .from(project_unit_bible_books)
      .innerJoin(books, eq(project_unit_bible_books.bookId, books.id))
      .where(eq(project_unit_bible_books.projectUnitId, projectUnitId))
      .orderBy(asc(project_unit_bible_books.bookId));

    return ok(rows);
  } catch (error) {
    logger.error('Failed to list book details', { error, projectUnitId });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function update(
  projectUnitId: number,
  bookId: number,
  input: UpdateBookDetailsInput
): Promise<Result<BookDetails>> {
  try {
    // Only touch what the caller sent: an absent field stays as it is, an
    // explicit null (or empty string, normalized by the schema) clears it.
    const set: Partial<{ runningHeader: string | null; bookTitle: string | null }> = {};
    if (input.runningHeader !== undefined) set.runningHeader = input.runningHeader;
    if (input.bookTitle !== undefined) set.bookTitle = input.bookTitle;

    const updated = await db
      .update(project_unit_bible_books)
      .set(set)
      .where(
        and(
          eq(project_unit_bible_books.projectUnitId, projectUnitId),
          eq(project_unit_bible_books.bookId, bookId)
        )
      )
      .returning({ bookId: project_unit_bible_books.bookId });

    if (updated.length === 0) {
      return err(ErrorCode.BOOK_NOT_FOUND);
    }

    const rows = await db
      .selectDistinct({
        bookId: project_unit_bible_books.bookId,
        bookCode: books.code,
        bookName: books.eng_display_name,
        runningHeader: project_unit_bible_books.runningHeader,
        bookTitle: project_unit_bible_books.bookTitle,
      })
      .from(project_unit_bible_books)
      .innerJoin(books, eq(project_unit_bible_books.bookId, books.id))
      .where(
        and(
          eq(project_unit_bible_books.projectUnitId, projectUnitId),
          eq(project_unit_bible_books.bookId, bookId)
        )
      );

    if (rows.length === 0) {
      return err(ErrorCode.BOOK_NOT_FOUND);
    }

    return ok(rows[0]);
  } catch (error) {
    logger.error('Failed to update book details', { error, projectUnitId, bookId });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
