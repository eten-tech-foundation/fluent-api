import { eq, inArray } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { books } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { Book } from './books.types';

// Old Testament books codes (39 books)
const OLD_TESTAMENT_CODES = [
  'GEN',
  'EXO',
  'LEV',
  'NUM',
  'DEU',
  'JOS',
  'JDG',
  'RUT',
  '1SA',
  '2SA',
  '1KI',
  '2KI',
  '1CH',
  '2CH',
  'EZR',
  'NEH',
  'EST',
  'JOB',
  'PSA',
  'PRO',
  'ECC',
  'SNG',
  'ISA',
  'JER',
  'LAM',
  'EZK',
  'DAN',
  'HOS',
  'JOL',
  'AMO',
  'OBA',
  'JON',
  'MIC',
  'NAM',
  'HAB',
  'ZEP',
  'HAG',
  'ZEC',
  'MAL',
];

// New Testament books codes (27 books)
const NEW_TESTAMENT_CODES = [
  'MAT',
  'MRK',
  'LUK',
  'JHN',
  'ACT',
  'ROM',
  '1CO',
  '2CO',
  'GAL',
  'EPH',
  'PHP',
  'COL',
  '1TH',
  '2TH',
  '1TI',
  '2TI',
  'TIT',
  'PHM',
  'HEB',
  'JAS',
  '1PE',
  '2PE',
  '1JN',
  '2JN',
  '3JN',
  'JUD',
  'REV',
];

export async function getAll(): Promise<Result<Book[]>> {
  try {
    return ok(await db.select().from(books));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get all books' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getById(id: number): Promise<Result<Book>> {
  try {
    const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
    if (!book) return err(ErrorCode.BOOK_NOT_FOUND);
    return ok(book);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get book by ID', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getByCode(code: string): Promise<Result<Book>> {
  try {
    const [book] = await db
      .select()
      .from(books)
      .where(eq(books.code, code.trim().toUpperCase()))
      .limit(1);
    if (!book) return err(ErrorCode.BOOK_NOT_FOUND);
    return ok(book);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get book by code', context: { code } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getOldTestament(): Promise<Result<Book[]>> {
  try {
    return ok(await db.select().from(books).where(inArray(books.code, OLD_TESTAMENT_CODES)));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get Old Testament books' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getNewTestament(): Promise<Result<Book[]>> {
  try {
    return ok(await db.select().from(books).where(inArray(books.code, NEW_TESTAMENT_CODES)));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get New Testament books' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
