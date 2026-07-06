import type { Result, User } from '@/lib/types';

import env from '@/env';
import { logger } from '@/lib/logger';
import { getQueue, QUEUE_NAMES } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  AiSuggestionItem,
  AiSuggestionsListResponse,
  GetAiSuggestionsQuery,
  QueueNextVersesResponse,
  SuggestionContextRequest,
  SuggestionContextResponse,
  TrackUsageRequest,
} from './ai-suggestions.types';

import {
  checkBibleTextsExist,
  findNextUntranslatedVerses,
  getAiSuggestions as getAiSuggestionsRepo,
  getBookCodeById,
  getChapterAssignmentAiStatus,
  getSuggestionContextData,
  hasReachedAiActivationThreshold,
  logAiSuggestionUsage,
  upsertAiSuggestions,
} from './ai-suggestions.repository';

export async function trackUsage(user: User, data: TrackUsageRequest): Promise<Result<void>> {
  return logAiSuggestionUsage(user.id, data.bibleTextId, data.projectUnitId, data.wasUsed);
}

export async function getAiSuggestions(
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
  projectUnitId: number,
  bibleId: number,
  bookCode: string,
  chapterNumber: number,
  currentVerse: number
): Promise<Result<QueueNextVersesResponse>> {
  try {
    const [isThresholdMet, isAiEnabled] = await Promise.all([
      hasReachedAiActivationThreshold(projectUnitId, env.AI_ACTIVATION_THRESHOLD_VERSES),
      getChapterAssignmentAiStatus(projectUnitId, bibleId, bookCode, chapterNumber),
    ]);

    if (isAiEnabled === null) {
      return err(ErrorCode.INVALID_REFERENCE);
    }

    if (!isThresholdMet || !isAiEnabled) {
      return ok({ queued: false, thresholdMet: isThresholdMet });
    }

    await queueNextVersesForAssignment(
      projectUnitId,
      bibleId,
      bookCode.toUpperCase(),
      chapterNumber,
      currentVerse,
      env.AI_DEFAULT_LOOKAHEAD
    );

    return ok({ queued: true, thresholdMet: true });
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

  try {
    const boss = await getQueue();
    await Promise.all(jobs.map((job) => boss.send(QUEUE_NAMES.AI_SUGGESTION_TRIGGER, job)));
    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to enqueue AI suggestion jobs',
      context: { jobCount: jobs.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
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

    const isThresholdMet = await hasReachedAiActivationThreshold(
      projectUnitId,
      env.AI_ACTIVATION_THRESHOLD_VERSES
    );

    if (isThresholdMet) {
      await queueNextVersesForAssignment(
        projectUnitId,
        bibleId,
        bookCode.toUpperCase(),
        chapterNumber,
        0,
        env.AI_INITIAL_QUEUE_COUNT
      );
    }

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

// ─── Internal (machine-facing) service functions ──────────────────────────────

export async function getSuggestionContext(
  params: SuggestionContextRequest
): Promise<Result<SuggestionContextResponse>> {
  const { projectUnitId, bibleId, bookCode, chapterNumber, verseStart, verseEnd } = params;

  // MAX_CONTEXT_VERSES_TOTAL = 100
  const limit = 100;

  return getSuggestionContextData(
    projectUnitId,
    bibleId,
    bookCode,
    chapterNumber,
    verseStart, // targetVerseNumber used for FTS
    verseStart,
    verseEnd,
    limit
  );
}

export async function saveAiSuggestions(items: AiSuggestionItem[]): Promise<Result<void>> {
  return upsertAiSuggestions(items);
}
