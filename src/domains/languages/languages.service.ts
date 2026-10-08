import { ok } from '@/lib/types';

import type { Language, LanguageResponse } from './languages.types';

import * as languagesRepo from './languages.repository';

export function toLanguageResponse(language: Language): LanguageResponse {
  return {
    id: language.id,
    langName: language.langName,
    langNameLocalized: language.langNameLocalized,
    langCodeIso6393: language.langCodeIso6393,
    scriptDirection: language.scriptDirection,
  };
}

export async function getAllLanguages(updatedAfter?: Date) {
  const result = await languagesRepo.getAll(updatedAfter);
  if (!result.ok) return result;

  return ok(result.data.map(toLanguageResponse));
}

export async function getLanguageById(id: number) {
  const result = await languagesRepo.getById(id);
  if (!result.ok) return result;
  return ok(toLanguageResponse(result.data));
}
