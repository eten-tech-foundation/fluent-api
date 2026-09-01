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

import { MAX_CONTEXT_VERSES_TOTAL } from './ai-suggestions.constants';
import {
  findVersesNeedingSuggestions,
  getBibleTextLocation,
  getChapterPericopeVerseGroups,
  isExactlyAtAiActivationThreshold,
} from './ai-suggestions.pericope.repository';
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

/**
 * Navigation-triggered queuing (#417). The drafting views call this with the verse the
 * translator is now on; both views share one queue, so the unit is the pericope, not a window
 * of verses.
 */
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

    await queueFromVerse(
      projectUnitId,
      bibleId,
      bookCode.toUpperCase(),
      chapterNumber,
      currentVerse
    );

    return ok({ queued: true, thresholdMet: true });
  } catch (error) {
    logger.error(error);
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * The pericope the translator is in plus the one after it, never crossing into the next chapter
 * (#417): the next chapter's first pericope is only ever queued by its own assignment-time
 * trigger or the threshold backfill. A verse outside every pericope queues nothing.
 *
 * A project with no pericope set keeps the fixed look-ahead from #157/#158, since there is no
 * pericope to size the work by.
 */
async function queueFromVerse(
  projectUnitId: number,
  bibleId: number,
  bookCode: string,
  chapterNumber: number,
  currentVerse: number
): Promise<Result<void>> {
  const pericopes = await getChapterPericopeVerseGroups(projectUnitId, bookCode, chapterNumber);

  if (pericopes.length === 0) {
    const nextVerses = await findNextUntranslatedVerses(
      projectUnitId,
      bibleId,
      bookCode,
      chapterNumber,
      currentVerse,
      env.AI_DEFAULT_LOOKAHEAD
    );
    return sendVerseJobs(projectUnitId, bibleId, bookCode, chapterNumber, nextVerses);
  }

  const index = pericopes.findIndex((verses) => verses.includes(currentVerse));
  if (index === -1) return ok(undefined);

  const wanted = pericopes.slice(index, index + 2).flat();
  const needing = await findVersesNeedingSuggestions(
    projectUnitId,
    bibleId,
    bookCode,
    chapterNumber,
    wanted
  );
  return sendVerseJobs(projectUnitId, bibleId, bookCode, chapterNumber, needing);
}

/**
 * The first pericope of a chapter, which is the only speculative queuing #417 allows: a
 * translator may not reach an assigned chapter for weeks, so one pericope of runway is all that
 * is spun up ahead of them. Without a pericope set, the initial count from #158.
 */
async function queueFirstPericope(
  projectUnitId: number,
  bibleId: number,
  bookCode: string,
  chapterNumber: number
): Promise<Result<void>> {
  const pericopes = await getChapterPericopeVerseGroups(projectUnitId, bookCode, chapterNumber);

  const wanted =
    pericopes.length === 0
      ? await findNextUntranslatedVerses(
          projectUnitId,
          bibleId,
          bookCode,
          chapterNumber,
          0,
          env.AI_INITIAL_QUEUE_COUNT
        )
      : await findVersesNeedingSuggestions(
          projectUnitId,
          bibleId,
          bookCode,
          chapterNumber,
          pericopes[0]
        );

  return sendVerseJobs(projectUnitId, bibleId, bookCode, chapterNumber, wanted);
}

/**
 * One job per verse, deduplicated per verse. The decision of *which* verses is pericope-level;
 * the job stays per-verse because that is the contract fluent-ai is known to handle, and it
 * lets a drafted verse in the middle of a pericope be left out without splitting the job.
 */
async function sendVerseJobs(
  projectUnitId: number,
  bibleId: number,
  bookCode: string,
  chapterNumber: number,
  verseNumbers: number[]
): Promise<Result<void>> {
  if (verseNumbers.length === 0) return ok(undefined);

  const jobs = verseNumbers.map((verseNumber) => ({
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

/**
 * Assignment-time queuing (#417): the first pericope of the chapter, subject to both gates. The
 * toggle check is here rather than only in the callers because #417 wants it on every enqueue,
 * and a chapter can be assigned with AI still switched off.
 */
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

    const normalizedBookCode = bookCode.toUpperCase();
    const [isThresholdMet, isAiEnabled] = await Promise.all([
      hasReachedAiActivationThreshold(projectUnitId, env.AI_ACTIVATION_THRESHOLD_VERSES),
      getChapterAssignmentAiStatus(projectUnitId, bibleId, normalizedBookCode, chapterNumber),
    ]);

    if (isThresholdMet && isAiEnabled) {
      await queueFirstPericope(projectUnitId, bibleId, normalizedBookCode, chapterNumber);
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

/**
 * Threshold backfill (#417). A chapter assigned before the project family reached the
 * activation threshold got no assignment-time queuing, so the save that crosses the threshold
 * makes up for it: the first pericope of the chapter being drafted, and of the chapter after it.
 *
 * Called after every draft save; it is a no-op unless this save is the crossing one. Both
 * chapters still go through the toggle, and the next chapter is skipped unless it is actually
 * assigned in this project unit. Duplicate sends from two saves racing on the threshold are
 * absorbed by the per-verse singletonKey.
 */
export async function handleThresholdCrossed(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<void>> {
  try {
    const crossed = await isExactlyAtAiActivationThreshold(
      projectUnitId,
      env.AI_ACTIVATION_THRESHOLD_VERSES
    );
    if (!crossed) return ok(undefined);

    const location = await getBibleTextLocation(bibleTextId);
    if (!location) return ok(undefined);

    const bookCode = location.bookCode.toUpperCase();
    for (const chapterNumber of [location.chapterNumber, location.chapterNumber + 1]) {
      const isAiEnabled = await getChapterAssignmentAiStatus(
        projectUnitId,
        location.bibleId,
        bookCode,
        chapterNumber
      );
      // null is "not assigned in this unit"; false is the toggle. Neither gets queued.
      if (isAiEnabled !== true) continue;

      await queueFirstPericope(projectUnitId, location.bibleId, bookCode, chapterNumber);
    }

    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to backfill AI queue on threshold crossing',
      context: { projectUnitId, bibleTextId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

// ─── Internal (machine-facing) service functions ──────────────────────────────

export async function getSuggestionContext(
  params: SuggestionContextRequest
): Promise<Result<SuggestionContextResponse>> {
  const { projectUnitId, bibleId, bookCode, chapterNumber, verseStart, verseEnd } = params;

  return getSuggestionContextData(
    projectUnitId,
    bibleId,
    bookCode,
    chapterNumber,
    verseStart, // targetVerseNumber used for FTS
    verseStart,
    verseEnd,
    MAX_CONTEXT_VERSES_TOTAL
  );
}

export async function saveAiSuggestions(items: AiSuggestionItem[]): Promise<Result<void>> {
  return upsertAiSuggestions(items);
}
