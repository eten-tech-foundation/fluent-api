import { ok } from '@/lib/types';

import type {
  CreateTranslatedVerseInput,
  TranslatedVerseRecord,
  TranslatedVerseResponse,
  TranslatedVersesFilters,
  UpdateTranslatedVerseInput,
} from './translated-verses.types';

import * as translatedVersesRepo from './translated-verses.repository';

// Data boundary mapping
function toTranslatedVerseResponse(verse: TranslatedVerseRecord): TranslatedVerseResponse {
  return {
    id: verse.id,
    projectUnitId: verse.projectUnitId,
    content: verse.content,
    bibleTextId: verse.bibleTextId,
    assignedUserId: verse.assignedUserId,
    verseNumber: verse.verseNumber,
    createdAt: verse.createdAt.toISOString(),
    updatedAt: verse.updatedAt.toISOString(),
  };
}

export async function getTranslatedVerseById(id: number) {
  const result = await translatedVersesRepo.getById(id);
  if (!result.ok) return result;
  return ok(toTranslatedVerseResponse(result.data));
}

export async function createTranslatedVerse(input: CreateTranslatedVerseInput) {
  const result = await translatedVersesRepo.create(input);
  if (!result.ok) return result;
  return ok(toTranslatedVerseResponse(result.data));
}

export async function updateTranslatedVerse(id: number, input: UpdateTranslatedVerseInput) {
  const result = await translatedVersesRepo.update(id, input);
  if (!result.ok) return result;
  return ok(toTranslatedVerseResponse(result.data));
}

export async function upsertTranslatedVerse(input: CreateTranslatedVerseInput) {
  const result = await translatedVersesRepo.upsert(input);
  if (!result.ok) return result;
  return ok(toTranslatedVerseResponse(result.data));
}

export async function listTranslatedVerses(filters: TranslatedVersesFilters = {}) {
  const result = await translatedVersesRepo.list(filters);
  if (!result.ok) return result;
  return ok(result.data.map(toTranslatedVerseResponse));
}
