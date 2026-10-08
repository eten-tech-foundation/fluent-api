import { ok } from '@/lib/types';

import type { Book, BookResponse } from './books.types';

import * as repo from './books.repository';

function toResponse(book: Book): BookResponse {
  return {
    id: book.id,
    code: book.code,
    eng_display_name: book.eng_display_name,
  };
}

export async function getAllBooks(updatedAfter?: Date) {
  const result = await repo.getAll(updatedAfter);
  if (!result.ok) return result;
  return ok(result.data.map(toResponse));
}

export async function getBookById(id: number) {
  const result = await repo.getById(id);
  if (!result.ok) return result;
  return ok(toResponse(result.data));
}

export async function getBookByCode(code: string) {
  const result = await repo.getByCode(code);
  if (!result.ok) return result;
  return ok(toResponse(result.data));
}

export async function getOldTestamentBooks() {
  const result = await repo.getOldTestament();
  if (!result.ok) return result;
  return ok(result.data.map(toResponse));
}

export async function getNewTestamentBooks() {
  const result = await repo.getNewTestament();
  if (!result.ok) return result;
  return ok(result.data.map(toResponse));
}
