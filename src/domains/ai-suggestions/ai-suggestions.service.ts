import type { AiSuggestionTriggerJob } from '@/lib/queue';
import type { DbTransaction, Result, User } from '@/lib/types';

import * as pericopesService from '@/domains/pericopes/pericopes.service';
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
  familyHasReachedAiActivationThreshold,
  findNextUntranslatedVerses,
  findVersesNeedingSuggestions,
  getAiActivationFamily,
  getAiSuggestions as getAiSuggestionsRepo,
  getBibleTextLocation,
  getBookCodeById,
  getChapterAssignmentAiStatus,
  getProjectIdForProjectUnit,
  getSuggestionContextData,
  hasReachedAiActivationThreshold,
  lockAiActivationFamily,
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

    const queued = await queueFromVerse(
      projectUnitId,
      bibleId,
      bookCode.toUpperCase(),
      chapterNumber,
      currentVerse
    );
    if (!queued.ok) return queued;

    return ok({ queued: true, thresholdMet: true });
  } catch (error) {
    logger.error(error);
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * The chapter's pericopes as verse-number groups, from the same source the pericope view reads,
 * so the queue and the translator can never disagree about where a pericope starts. An empty
 * list means no pericope set or a chapter the set does not cover, which is the verse-by-verse
 * fallback; a failed lookup is an error and stays one, rather than being mistaken for that.
 */
async function chapterPericopeVerseGroups(
  projectUnitId: number,
  bookCode: string,
  chapterNumber: number
): Promise<Result<number[][]>> {
  const projectId = await getProjectIdForProjectUnit(projectUnitId);
  if (projectId === null) return ok([]);

  const result = await pericopesService.getChapterPericopes(projectId, bookCode, chapterNumber);
  if (!result.ok) return result;

  return ok(result.data.map((group) => group.verses.map((verse) => verse.verseNumber)));
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
  const pericopesResult = await chapterPericopeVerseGroups(projectUnitId, bookCode, chapterNumber);
  if (!pericopesResult.ok) return pericopesResult;
  const pericopes = pericopesResult.data;

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
  if (index === -1) {
    logger.debug(
      { projectUnitId, bookCode, chapterNumber, currentVerse },
      'AI queue skipped because the current verse is outside every pericope'
    );
    return ok(undefined);
  }

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
  const pericopesResult = await chapterPericopeVerseGroups(projectUnitId, bookCode, chapterNumber);
  if (!pericopesResult.ok) return pericopesResult;
  const pericopes = pericopesResult.data;

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
      return queueFirstPericope(projectUnitId, bibleId, normalizedBookCode, chapterNumber);
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
 * Runs a draft save inside the caller's transaction and reports whether it is the save that took
 * the project family over the AI activation threshold (#417). The claim has to happen in the same
 * transaction as the write, so the caller hands its `tx` over rather than asking afterwards.
 *
 * `crossed: true` is the caller's cue to call handleThresholdCrossed — once the transaction has
 * committed, never inside it. This is an at-most-once attempt: the claim is not persisted for
 * retry, so a process crash after commit or a failed backfill can lose the automatic backfill.
 */
export async function claimActivationCrossing<T>(
  tx: DbTransaction,
  projectUnitId: number,
  write: () => Promise<Result<T>>
): Promise<{ written: Result<T>; crossed: boolean }> {
  const threshold = env.AI_ACTIVATION_THRESHOLD_VERSES;
  const family = await getAiActivationFamily(projectUnitId, tx);

  // Already-active families skip the lock. Families that remain below the threshold keep
  // taking it on every save. A near-threshold pre-check cannot safely skip it: concurrent
  // unlocked saves could cross the threshold without any one of them observing the crossing.
  if (!family || (await familyHasReachedAiActivationThreshold(family, threshold, tx))) {
    return { written: await write(), crossed: false };
  }

  await lockAiActivationFamily(family, tx);

  // Under READ COMMITTED, a waiter sees the winner's committed write in this measurement.
  // The closure keeps the local draft write between the two measurements on the same tx.
  const before = await familyHasReachedAiActivationThreshold(family, threshold, tx);
  const written = await write();
  if (!written.ok || before) return { written, crossed: false };

  const after = await familyHasReachedAiActivationThreshold(family, threshold, tx);
  return { written, crossed: after };
}

/**
 * Threshold backfill (#417). A chapter assigned before the project family reached the
 * activation threshold got no assignment-time queuing, so the save that crosses the threshold
 * makes up for it: the current and next pericopes around the saved verse, and the first pericope
 * of the chapter after it.
 *
 * Only ever called for the save that claimed the crossing (see claimActivationCrossing), which is
 * why there is no threshold check here. Both chapters still go through the toggle, and the next
 * chapter is skipped unless it is actually assigned in this project unit.
 */
export async function handleThresholdCrossed(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<void>> {
  try {
    const location = await getBibleTextLocation(bibleTextId);
    if (!location) return ok(undefined);

    const bookCode = location.bookCode.toUpperCase();
    let failure: Result<void> | null = null;

    for (const chapterNumber of [location.chapterNumber, location.chapterNumber + 1]) {
      const isAiEnabled = await getChapterAssignmentAiStatus(
        projectUnitId,
        location.bibleId,
        bookCode,
        chapterNumber
      );
      // null is "not assigned in this unit"; false is the toggle. Neither gets queued.
      if (isAiEnabled !== true) continue;

      // Both chapters are attempted even if the first one fails to enqueue; the first failure is
      // what gets reported.
      const queued =
        chapterNumber === location.chapterNumber
          ? await queueFromVerse(
              projectUnitId,
              location.bibleId,
              bookCode,
              chapterNumber,
              location.verseNumber
            )
          : await queueFirstPericope(projectUnitId, location.bibleId, bookCode, chapterNumber);
      if (!queued.ok && !failure) failure = queued;
    }

    return failure ?? ok(undefined);
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

  let heading: SuggestionContextResponse['sectionHeading'];
  let sourceIds: Set<number> | undefined;
  if (params.pericopeNumber !== undefined) {
    if (params.pericopeSetId === undefined) return err(ErrorCode.INVALID_REFERENCE);
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
      params.pericopeSetId !== resolved.data.pericopeSetId ||
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
    const results = await Promise.allSettled(
      jobs.map((job) => {
        const verseKey = `${job.projectUnitId}:${job.bibleId}:${job.bookCode}:${job.chapterNumber}:${job.verseStart}`;
        return boss.send(QUEUE_NAMES.AI_SUGGESTIONS, job, {
          singletonKey:
            job.pericopeNumber === undefined
              ? verseKey
              : `heading:${verseKey}:${job.verseEnd}:${job.pericopeSetId}:${job.pericopeNumber}`,
        });
      })
    );
    const accepted = results.filter(
      (result) => result.status === 'fulfilled' && result.value !== null
    ).length;
    const deduped = results.filter(
      (result) => result.status === 'fulfilled' && result.value === null
    ).length;
    const rejected = results.filter((result) => result.status === 'rejected');
    logger.debug('Pericope AI suggestion jobs submitted to queue', {
      total: results.length,
      accepted,
      deduped,
      failed: rejected.length,
      projectUnitId: params.projectUnitId,
      bookCode: base.bookCode,
      chapterNumber: params.chapterNumber,
    });
    if (rejected.length > 0) {
      logger.error({
        cause: rejected[0].reason,
        message: 'Failed to enqueue some pericope AI suggestion jobs',
        context: { total: results.length, accepted, deduped, failed: rejected.length },
      });
      return err(ErrorCode.INTERNAL_ERROR);
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
          bibleTextId: group.verses[0].bibleTextId,
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
