import { db } from '@/db';
import { verseMarkersSchema } from '@/db/schema';
import * as aiSuggestionsService from '@/domains/ai-suggestions/ai-suggestions.service';
import * as projectsService from '@/domains/projects/projects.service';
import { logger } from '@/lib/logger';
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
    markers: verseMarkersSchema.catch(null).parse(verse.markers ?? null),
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
  const result = await db.transaction(async (tx) => {
    const upserted = await translatedVersesRepo.upsert(input, tx);
    if (!upserted.ok) return upserted;
    // Update the last activity timestamp for the associated project when a translated verse is upserted
    await projectsService.touchProjectActivity(upserted.data.projectUnitId, tx);

    return upserted;
  });

  if (!result.ok) return result;

  // #417: the save that pushes the project family over the AI activation threshold backfills the
  // queuing that assignment-time never got to do. Runs after the transaction has committed, and a
  // failure here must not turn an already-saved draft into an error for the translator.
  try {
    await aiSuggestionsService.handleThresholdCrossed(
      result.data.projectUnitId,
      result.data.bibleTextId
    );
  } catch (error) {
    logger.error({
      cause: error,
      message: 'AI threshold backfill failed after draft save',
      context: { projectUnitId: result.data.projectUnitId, bibleTextId: result.data.bibleTextId },
    });
  }

  return ok(toTranslatedVerseResponse(result.data));
}

export async function listTranslatedVerses(filters: TranslatedVersesFilters = {}) {
  const result = await translatedVersesRepo.list(filters);
  if (!result.ok) return result;
  return ok(result.data.map(toTranslatedVerseResponse));
}
