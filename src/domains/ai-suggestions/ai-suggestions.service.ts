import type { Result, User } from '@/lib/types';

import env from '@/env';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  AiSuggestionsListResponse,
  GetAiSuggestionsQuery,
  TrackUsageRequest,
} from './ai-suggestions.types';

import {
  checkBibleTextsExist,
  findNextUntranslatedVerses,
  getAiSuggestions as getAiSuggestionsRepo,
  getBookCodeById,
  getChapterAssignmentAiStatus,
  logAiSuggestionUsage,
  queueAiSuggestionJobs,
} from './ai-suggestions.repository';

export async function trackUsage(user: User, data: TrackUsageRequest): Promise<Result<void>> {
  return logAiSuggestionUsage(user.id, data.bibleTextId, data.projectUnitId, data.wasUsed);
}

export async function getAiSuggestions(
  user: User,
  query: GetAiSuggestionsQuery
): Promise<Result<AiSuggestionsListResponse>> {
  const ids = query.bibleTextIds;

  if (
    ids.length === 0 ||
    ids.length > env.AI_MAX_REQUESTED_BIBLE_TEXT_IDS ||
    ids.length !== new Set(ids).size
  ) {
    return err(ErrorCode.VALIDATION_ERROR);
  }

  const allExist = await checkBibleTextsExist(ids);
  if (!allExist) {
    return err(ErrorCode.VALIDATION_ERROR);
  }

  const suggestionsResult = await getAiSuggestionsRepo(query.projectUnitId, ids);

  if (!suggestionsResult.ok) {
    return suggestionsResult;
  }

  const data = suggestionsResult.data.map((suggestion) => ({
    bibleTextId: suggestion.bibleTextId,
    suggestedText: suggestion.suggestedText,
    modelInfo: suggestion.modelInfo,
  }));

  return ok({ data });
}

export async function queueNextVerses(
  user: User,
  projectUnitId: number,
  bibleId: number,
  bookCode: string,
  chapterNumber: number,
  currentVerse: number,
  lookahead: number = env.AI_DEFAULT_LOOKAHEAD
): Promise<Result<void>> {
  try {
    const isAiEnabled = await getChapterAssignmentAiStatus(
      projectUnitId,
      bibleId,
      bookCode,
      chapterNumber
    );

    if (isAiEnabled === null) {
      return err(ErrorCode.INVALID_REFERENCE);
    }

    if (!isAiEnabled) {
      return ok(undefined);
    }

    return await queueNextVersesForAssignment(
      projectUnitId,
      bibleId,
      bookCode.toUpperCase(),
      chapterNumber,
      currentVerse,
      lookahead
    );
  } catch (error) {
    logger.error(error);
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

async function queueNextVersesForAssignment(
  projectUnitId: number,
  bibleId: number,
  bookCode: string,
  chapterNumber: number,
  currentVerse: number,
  lookahead: number
): Promise<Result<void>> {
  const nextVerses = await findNextUntranslatedVerses(
    projectUnitId,
    bibleId,
    bookCode,
    chapterNumber,
    currentVerse,
    lookahead
  );

  if (nextVerses.length === 0) return ok(undefined);

  const jobs = nextVerses.map((verseNumber) => ({
    projectUnitId,
    bibleId,
    bookCode,
    chapterNumber,
    verseStart: verseNumber,
    verseEnd: verseNumber,
  }));

  return queueAiSuggestionJobs(jobs);
}

export async function handleChapterAssigned(
  projectUnitId: number,
  bibleId: number,
  bookId: number,
  chapterNumber: number
): Promise<Result<void>> {
  try {
    const bookCode = await getBookCodeById(bookId);

    if (!bookCode) {
      return ok(undefined);
    }

    await queueNextVersesForAssignment(
      projectUnitId,
      bibleId,
      bookCode.toUpperCase(),
      chapterNumber,
      0,
      env.AI_INITIAL_QUEUE_COUNT
    );

    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to trigger initial AI queue on chapter assignment',
      context: { projectUnitId, chapterNumber },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
