import type { AiSuggestionTriggerJob } from '@/lib/queue';
import type { Result, User } from '@/lib/types';

import env from '@/env';
import { logger } from '@/lib/logger';
import { getQueue, QUEUE_NAMES } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  AiSuggestionItem,
  AiSuggestionsListResponse,
  GetAiSuggestionsQuery,
  PericopeRequest,
  PericopeSuggestionItem,
  PericopeSuggestionsResponse,
  PericopeUsageRequest,
  QueueNextVersesResponse,
  SuggestionContextRequest,
  SuggestionContextResponse,
  TrackUsageRequest,
} from './ai-suggestions.types';

import {
  logPericopeUsage,
  resolvePericopes,
  savePericopeSuggestion,
} from './ai-pericope.repository';
import { MAX_CONTEXT_VERSES_TOTAL } from './ai-suggestions.constants';
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

    const queued = await queueNextVersesForAssignment(
      projectUnitId,
      bibleId,
      bookCode.toUpperCase(),
      chapterNumber,
      currentVerse,
      env.AI_DEFAULT_LOOKAHEAD
    );
    if (!queued.ok) return queued;

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
    const results = await Promise.all(
      jobs.map((job) =>
        boss.send(QUEUE_NAMES.AI_SUGGESTIONS, job, {
          // Deduplication key scoped to the exact verse. pgboss silently drops
          // a send() if a job with the same singletonKey is already pending or
          // running, returning null instead of a job ID.
          singletonKey: `${job.projectUnitId}:${job.bibleId}:${job.bookCode}:${job.chapterNumber}:${job.verseStart}`,
        })
      )
    );

    // pgboss returns null (not an error) when a singletonKey duplicate is
    // rejected — that is the correct dedup behaviour. Log it at debug so
    // operators can confirm the window is working as intended without any noise.
    const accepted = results.filter((id) => id !== null).length;
    const deduped = results.length - accepted;
    logger.debug('AI suggestion jobs submitted to queue', {
      total: results.length,
      accepted,
      deduped,
      projectUnitId,
      bookCode,
      chapterNumber,
    });

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

  let heading: SuggestionContextResponse['sectionHeading'];
  let sourceIds: Set<number> | undefined;
  if (params.pericopeNumber !== undefined) {
    const resolved = await resolvePericopes({
      projectUnitId,
      bibleId,
      bookCode,
      chapterNumber,
      pericopeNumbers: [params.pericopeNumber],
    });
    if (!resolved.ok) return resolved;
    const group = resolved.data.groups[0];
    if (
      (params.pericopeSetId !== undefined &&
        params.pericopeSetId !== resolved.data.pericopeSetId) ||
      verseStart !== group.verses[0].verseNumber ||
      verseEnd !== group.verses[group.verses.length - 1].verseNumber
    ) {
      return err(ErrorCode.INVALID_REFERENCE);
    }
    sourceIds = new Set(group.verses.map((verse) => verse.bibleTextId));
    heading =
      group.sourceTitle && resolved.data.isAiEnabled && !group.verses[0].hasAuthoredHeading
        ? {
            pericopeNumber: group.pericopeNumber,
            pericopeSetId: resolved.data.pericopeSetId,
            bibleTextId: group.verses[0].bibleTextId,
            sourceTitle: group.sourceTitle,
          }
        : null;
  }

  const result = await getSuggestionContextData(
    projectUnitId,
    bibleId,
    bookCode,
    chapterNumber,
    verseStart, // targetVerseNumber used for FTS
    verseStart,
    verseEnd,
    MAX_CONTEXT_VERSES_TOTAL
  );
  if (!result.ok) return result;
  return ok({
    ...result.data,
    ...(params.pericopeNumber !== undefined
      ? {
          sectionHeading: heading ?? null,
          sourceVerses: result.data.sourceVerses.filter((verse) => sourceIds?.has(verse.id)),
        }
      : {}),
  });
}

export async function saveAiSuggestions(
  items: AiSuggestionItem[],
  heading?: PericopeSuggestionItem
): Promise<Result<void>> {
  if (heading) {
    if (items.length) return err(ErrorCode.VALIDATION_ERROR);
    try {
      return await savePericopeSuggestion(heading);
    } catch (error) {
      logger.error(error);
      return err(ErrorCode.INTERNAL_ERROR);
    }
  }
  return upsertAiSuggestions(items);
}

export async function queuePericopes(
  params: PericopeRequest
): Promise<Result<QueueNextVersesResponse>> {
  try {
    const resolved = await resolvePericopes(params);
    if (!resolved.ok) return resolved;
    const thresholdMet = await hasReachedAiActivationThreshold(
      params.projectUnitId,
      env.AI_ACTIVATION_THRESHOLD_VERSES
    );
    if (!thresholdMet || !resolved.data.isAiEnabled) return ok({ queued: false, thresholdMet });
    const jobs: AiSuggestionTriggerJob[] = [];
    const base = {
      projectUnitId: params.projectUnitId,
      bibleId: params.bibleId,
      bookCode: params.bookCode.toUpperCase(),
      chapterNumber: params.chapterNumber,
    };
    for (const group of resolved.data.groups) {
      for (const verse of group.verses) {
        if (!verse.content?.trim() && !verse.hasSuggestion) {
          jobs.push({ ...base, verseStart: verse.verseNumber, verseEnd: verse.verseNumber });
        }
      }
      if (group.sourceTitle && !group.verses[0].hasAuthoredHeading && !group.suggestion) {
        jobs.push({
          ...base,
          verseStart: group.verses[0].verseNumber,
          verseEnd: group.verses[group.verses.length - 1].verseNumber,
          pericopeNumber: group.pericopeNumber,
          pericopeSetId: resolved.data.pericopeSetId,
        });
      }
    }
    if (jobs.length === 0) return ok({ queued: false, thresholdMet });
    const boss = await getQueue();
    // Keep verse singleton keys identical to queue-next. Titles have their own identity.
    for (const job of jobs) {
      const verseKey = `${job.projectUnitId}:${job.bibleId}:${job.bookCode}:${job.chapterNumber}:${job.verseStart}`;
      await boss.send(QUEUE_NAMES.AI_SUGGESTIONS, job, {
        singletonKey:
          job.pericopeNumber === undefined
            ? verseKey
            : `heading:${verseKey}:${job.verseEnd}:${job.pericopeSetId}:${job.pericopeNumber}`,
      });
    }
    return ok({ queued: true, thresholdMet });
  } catch (error) {
    logger.error(error);
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getPericopeSuggestions(
  params: PericopeRequest
): Promise<Result<PericopeSuggestionsResponse>> {
  try {
    const resolved = await resolvePericopes(params);
    if (!resolved.ok) return resolved;
    const data = resolved.data.groups.flatMap((group) => {
      if (!group.sourceTitle || group.verses[0].hasAuthoredHeading || !group.suggestion) return [];
      return [
        {
          pericopeNumber: group.pericopeNumber,
          bibleTextId: group.suggestion.bibleTextId,
          suggestedText: group.suggestion.suggestedText,
          modelInfo: group.suggestion.modelInfo,
        },
      ];
    });
    return ok({ data });
  } catch (error) {
    logger.error(error);
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function trackPericopeUsage(
  user: User,
  data: PericopeUsageRequest
): Promise<Result<void>> {
  try {
    return await logPericopeUsage(user.id, data);
  } catch (error) {
    logger.error(error);
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
