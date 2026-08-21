import { and, asc, eq } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { books, project_unit_bible_books } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { BookDetailField, BookDetails, UpdateBookDetailsInput } from './book-details.types';

import { BOOK_DETAIL_FIELDS } from './book-details.types';

/**
 * Shared so the list and the read-back of an update cannot drift apart: a field
 * added to one projection and forgotten in the other is invisible to tsc, since
 * both feed the same `BookDetails` shape only by convention.
 *
 * Exported for the same reason it is shared. This is the actual 200 payload shape;
 * `bookDetailsSchema` is the shape the OpenAPI document declares, and nothing at
 * runtime or compile time checks one against the other. The key-set assertion in
 * book-details.repository.test.ts is what does (#275 review).
 */
export const BOOK_DETAILS_PROJECTION = {
  bookId: project_unit_bible_books.bookId,
  bookCode: books.code,
  bookName: books.eng_display_name,
  runningHeader: project_unit_bible_books.runningHeader,
  bookTitle: project_unit_bible_books.bookTitle,
  tocLongName: project_unit_bible_books.tocLongName,
  tocShortName: project_unit_bible_books.tocShortName,
  tocAbbreviation: project_unit_bible_books.tocAbbreviation,
};

export async function list(projectUnitId: number): Promise<Result<BookDetails[]>> {
  try {
    const rows = await db
      .selectDistinct(BOOK_DETAILS_PROJECTION)
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
    // Driven off BOOK_DETAIL_FIELDS rather than written out per field, because a
    // hand-written ladder that omits one field compiles, typechecks and silently
    // drops that field's writes.
    const set: Partial<Record<BookDetailField, string | null>> = {};
    for (const field of BOOK_DETAIL_FIELDS) {
      const value = input[field];
      if (value !== undefined) set[field] = value;
    }

    // One transaction so the echoed body is a genuine read-your-write: the dialog
    // PATCHes several fields at once and reconciles its form state from the
    // response, which a concurrent write landing between the two statements would
    // otherwise corrupt.
    return await db.transaction(async (tx) => {
      const updated = await tx
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

      const rows = await tx
        .selectDistinct(BOOK_DETAILS_PROJECTION)
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
    });
  } catch (error) {
    logger.error('Failed to update book details', { error, projectUnitId, bookId });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
