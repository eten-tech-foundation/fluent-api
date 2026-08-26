import { ok } from '@/lib/types';

import type {
  BibleBook,
  BibleBookDetailResponse,
  BibleBookResponse,
  BibleBookWithDetails,
  CreateBibleBookInput,
} from './bible-books.types';

import * as repo from './bible-books.repository';

function toDetailResponse(record: BibleBookWithDetails): BibleBookDetailResponse {
  return {
    bibleId: record.bibleId,
    bookId: record.bookId,
    createdAt: record.createdAt ? record.createdAt.toISOString() : null,
    updatedAt: record.updatedAt ? record.updatedAt.toISOString() : null,
    book: {
      id: record.book.id,
      code: record.book.code,
      eng_display_name: record.book.eng_display_name,
    },
    bible: {
      id: record.bible.id,
      name: record.bible.name,
    },
  };
}

function toResponse(record: BibleBook): BibleBookResponse {
  return {
    bibleId: record.bibleId,
    bookId: record.bookId,
    createdAt: record.createdAt ? record.createdAt.toISOString() : null,
    updatedAt: record.updatedAt ? record.updatedAt.toISOString() : null,
  };
}

export async function getBibleBooksByBibleId(bibleId: number) {
  const result = await repo.getByBibleId(bibleId);
  if (!result.ok) return result;
  return ok(result.data.map(toDetailResponse));
}

export async function getBibleBookByBibleIdAndBookId(bibleId: number, bookId: number) {
  const result = await repo.getByBibleIdAndBookId(bibleId, bookId);
  if (!result.ok) return result;
  return ok(toDetailResponse(result.data));
}

export async function createBibleBook(input: CreateBibleBookInput) {
  const result = await repo.create(input);
  if (!result.ok) return result;
  return ok(toResponse(result.data));
}

export function deleteBibleBook(bibleId: number, bookId: number) {
  return repo.remove(bibleId, bookId);
}
