import { and, eq } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_books, bibles, books } from '@/db/schema';
import { handleConstraintError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { BibleBook, BibleBookWithDetails, CreateBibleBookInput } from './bible-books.types';

const bibleBookSelect = {
  bibleId: bible_books.bibleId,
  bookId: bible_books.bookId,
  createdAt: bible_books.createdAt,
  updatedAt: bible_books.updatedAt,
  book: {
    id: books.id,
    code: books.code,
    eng_display_name: books.eng_display_name,
  },
  bible: {
    id: bibles.id,
    name: bibles.name,
  },
};

export async function getByBibleId(bibleId: number): Promise<Result<BibleBookWithDetails[]>> {
  try {
    const bibleBookList = await db
      .select(bibleBookSelect)
      .from(bible_books)
      .innerJoin(books, eq(bible_books.bookId, books.id))
      .innerJoin(bibles, eq(bible_books.bibleId, bibles.id))
      .where(eq(bible_books.bibleId, bibleId));

    return ok(bibleBookList);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get bible books by bibleId',
      context: { bibleId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getByBibleIdAndBookId(
  bibleId: number,
  bookId: number
): Promise<Result<BibleBookWithDetails>> {
  try {
    const [bibleBook] = await db
      .select(bibleBookSelect)
      .from(bible_books)
      .innerJoin(books, eq(bible_books.bookId, books.id))
      .innerJoin(bibles, eq(bible_books.bibleId, bibles.id))
      .where(and(eq(bible_books.bibleId, bibleId), eq(bible_books.bookId, bookId)))
      .limit(1);

    if (!bibleBook) return err(ErrorCode.BIBLE_BOOK_NOT_FOUND);
    return ok(bibleBook);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get bible book by ID',
      context: { bibleId, bookId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function create(input: CreateBibleBookInput): Promise<Result<BibleBook>> {
  try {
    const [bibleBook] = await db.insert(bible_books).values(input).returning();
    if (!bibleBook) return err(ErrorCode.INTERNAL_ERROR);
    return ok(bibleBook);
  } catch (error) {
    return handleConstraintError(error);
  }
}

export async function remove(bibleId: number, bookId: number): Promise<Result<void>> {
  try {
    const [deleted] = await db
      .delete(bible_books)
      .where(and(eq(bible_books.bibleId, bibleId), eq(bible_books.bookId, bookId)))
      .returning({ bibleId: bible_books.bibleId });

    if (!deleted) return err(ErrorCode.BIBLE_BOOK_NOT_FOUND);
    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to remove bible book',
      context: { bibleId, bookId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
