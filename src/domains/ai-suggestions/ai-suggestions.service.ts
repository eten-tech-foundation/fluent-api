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
  PericopeContext,
  PericopeRequest,
  PericopeSuggestionItem,
  PericopeSuggestionsResponse,
  PericopeUsageRequest,
  QueueNextVersesResponse,
  ResolvedPericope,
  SuggestionContextRequest,
  SuggestionContextResponse,
  TrackUsageRequest,
} from './ai-suggestions.types';

import * as pericopeRepo from './ai-pericope.repository';
import {
  canSuggestPericopeTitle,
  logPericopeUsage,
  savePericopeSuggestion,
} from './ai-pericope.service';
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

interface ChapterPericope {
  pericopeNumber: string;
  verseNumbers: number[];
}

/** The chapter a job belongs to; every job in one queue call shares it. */
type QueueTarget = Pick<
  AiSuggestionTriggerJob,
  'projectUnitId' | 'bibleId' | 'bookCode' | 'chapterNumber'
>;

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
): Promise<Result<ChapterPericope[]>> {
  const projectId = await getProjectIdForProjectUnit(projectUnitId);
  if (projectId === null) return ok([]);

  const result = await pericopesService.getChapterPericopes(projectId, bookCode, chapterNumber);
  if (!result.ok) return result;

  return ok(
    result.data.map((group) => ({
      pericopeNumber: group.pericopeNumber,
      verseNumbers: group.verses.map((verse) => verse.verseNumber),
    }))
  );
}

function verseJob(target: QueueTarget, verseNumber: number): AiSuggestionTriggerJob {
  return { ...target, verseStart: verseNumber, verseEnd: verseNumber };
}

/** The group's heading-only job, or null when the group gets no generated title. */
function titleJob(
  target: QueueTarget,
  context: PericopeContext,
  group: ResolvedPericope
): AiSuggestionTriggerJob | null {
  if (!canSuggestPericopeTitle(context, group) || group.suggestion) return null;
  return {
    ...target,
    verseStart: group.verses[0].verseNumber,
    verseEnd: group.verses[group.verses.length - 1].verseNumber,
    pericopeNumber: group.pericopeNumber,
    pericopeSetId: context.pericopeSetId,
  };
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
  const target = { projectUnitId, bibleId, bookCode, chapterNumber };

  if (pericopes.length === 0) {
    const nextVerses = await findNextUntranslatedVerses(
      projectUnitId,
      bibleId,
      bookCode,
      chapterNumber,
      currentVerse,
      env.AI_DEFAULT_LOOKAHEAD
    );
    return sendJobs(nextVerses.map((verse) => verseJob(target, verse)));
  }

  const index = pericopes.findIndex((group) => group.verseNumbers.includes(currentVerse));
  if (index === -1) {
    logger.debug(
      { projectUnitId, bookCode, chapterNumber, currentVerse },
      'AI queue skipped because the current verse is outside every pericope'
    );
    return ok(undefined);
  }

  const wanted = pericopes.slice(index, index + 2).flatMap((group) => group.verseNumbers);
  const needing = await findVersesNeedingSuggestions(
    projectUnitId,
    bibleId,
    bookCode,
    chapterNumber,
    wanted
  );
  return sendJobs(needing.map((verse) => verseJob(target, verse)));
}

/**
 * The first pericope of a chapter, which is the only speculative queuing #417 allows: a
 * translator may not reach an assigned chapter for weeks, so one pericope of runway is all that
 * is spun up ahead of them. Without a pericope set, the initial count from #158.
 *
 * The runway includes the pericope's title, ahead of its verses. Pericope view asks for the title
 * itself, but only after this has queued every verse, so the title used to come last (#394 QA).
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
  const target = { projectUnitId, bibleId, bookCode, chapterNumber };

  if (pericopes.length === 0) {
    const verses = await findNextUntranslatedVerses(
      projectUnitId,
      bibleId,
      bookCode,
      chapterNumber,
      0,
      env.AI_INITIAL_QUEUE_COUNT
    );
    return sendJobs(verses.map((verse) => verseJob(target, verse)));
  }

  const [first] = pericopes;
  const [resolved, verses] = await Promise.all([
    pericopeRepo.resolvePericopes({ ...target, pericopeNumbers: [first.pericopeNumber] }),
    findVersesNeedingSuggestions(
      projectUnitId,
      bibleId,
      bookCode,
      chapterNumber,
      first.verseNumbers
    ),
  ]);
  // The title is optional: a pericope that cannot be resolved still gets its verses.
  const title = resolved.ok ? titleJob(target, resolved.data, resolved.data.groups[0]) : null;

  return sendJobs([...(title ? [title] : []), ...verses.map((verse) => verseJob(target, verse))]);
}

/** Verse keys are shared by every queue path; a title has its own identity. */
function singletonKey(job: AiSuggestionTriggerJob): string {
  const verseKey = `${job.projectUnitId}:${job.bibleId}:${job.bookCode}:${job.chapterNumber}:${job.verseStart}`;
  return job.pericopeNumber === undefined
    ? verseKey
    : `heading:${verseKey}:${job.verseEnd}:${job.pericopeSetId}:${job.pericopeNumber}`;
}

/**
 * Queues jobs one at a time, in the order given, which is the order the worker generates them in:
 * pg-boss hands jobs out by creation time. Sent all at once, a pericope's title and verses were
 * created in whatever order their inserts committed, and the title often came last (#394 QA).
 *
 * Jobs stay one per verse because that is the contract fluent-ai is known to handle, and it lets a
 * drafted verse in the middle of a pericope be left out without splitting the job. pgboss silently
 * drops a send whose singletonKey is already pending or running, returning null instead of a job
 * ID; that is deduplication, not a failure. A failed send does not stop the jobs after it.
 */
async function sendJobs(jobs: AiSuggestionTriggerJob[]): Promise<Result<void>> {
  if (jobs.length === 0) return ok(undefined);

  let accepted = 0;
  let deduped = 0;
  const failures: unknown[] = [];
  try {
    const boss = await getQueue();
    for (const job of jobs) {
      try {
        const id = await boss.send(QUEUE_NAMES.AI_SUGGESTIONS, job, {
          singletonKey: singletonKey(job),
        });
        if (id === null) deduped += 1;
        else accepted += 1;
      } catch (error) {
        failures.push(error);
      }
    }
  } catch (error) {
    failures.push(error);
  }

  const { projectUnitId, bookCode, chapterNumber } = jobs[0];
  logger.debug('AI suggestion jobs submitted to queue', {
    total: jobs.length,
    accepted,
    deduped,
    failed: failures.length,
    projectUnitId,
    bookCode,
    chapterNumber,
  });
  if (failures.length > 0) {
    logger.error({
      cause: failures[0],
      message: 'Failed to enqueue AI suggestion jobs',
      context: { total: jobs.length, accepted, deduped, failed: failures.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
  return ok(undefined);
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

function inactiveHeadingContext(): Result<SuggestionContextResponse> {
  return ok({ targetLanguageName: '', contextVerses: [], sourceVerses: [], sectionHeading: null });
}

export async function getSuggestionContext(
  params: SuggestionContextRequest
): Promise<Result<SuggestionContextResponse>> {
  const { projectUnitId, bibleId, bookCode, chapterNumber, verseStart, verseEnd } = params;

  let heading: SuggestionContextResponse['sectionHeading'];
  let sourceIds: Set<number> | undefined;
  if (params.pericopeNumber !== undefined) {
    if (params.pericopeSetId === undefined) return err(ErrorCode.INVALID_REFERENCE);
    const resolved = await pericopeRepo.resolvePericopes({
      projectUnitId,
      bibleId,
      bookCode,
      chapterNumber,
      pericopeNumbers: [params.pericopeNumber],
    });
    if (!resolved.ok) {
      return resolved.error.code === ErrorCode.INVALID_REFERENCE
        ? inactiveHeadingContext()
        : resolved;
    }
    const group = resolved.data.groups[0];
    if (
      params.pericopeSetId !== resolved.data.pericopeSetId ||
      verseStart !== group.verses[0].verseNumber ||
      verseEnd !== group.verses[group.verses.length - 1].verseNumber
    ) {
      return inactiveHeadingContext();
    }
    if (!canSuggestPericopeTitle(resolved.data, group)) return inactiveHeadingContext();
    sourceIds = new Set(group.verses.map((verse) => verse.bibleTextId));
    heading = group.sourceTitle
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
    const resolved = await pericopeRepo.resolvePericopes(params);
    if (!resolved.ok) return resolved;
    const thresholdMet = await hasReachedAiActivationThreshold(
      params.projectUnitId,
      env.AI_ACTIVATION_THRESHOLD_VERSES
    );
    if (!thresholdMet || !resolved.data.isAiEnabled) return ok({ queued: false, thresholdMet });
    const target = {
      projectUnitId: params.projectUnitId,
      bibleId: params.bibleId,
      bookCode: params.bookCode.toUpperCase(),
      chapterNumber: params.chapterNumber,
    };
    // Reading order: each pericope's title ahead of its verses, the active pericope ahead of the
    // next. Titles used to go last and could arrive after the next group's verses (#394 QA).
    const jobs: AiSuggestionTriggerJob[] = [];
    for (const group of resolved.data.groups) {
      const title = titleJob(target, resolved.data, group);
      if (title) jobs.push(title);
      for (const verse of group.verses) {
        if (!verse.content?.trim() && !verse.hasSuggestion) {
          jobs.push(verseJob(target, verse.verseNumber));
        }
      }
    }
    if (jobs.length === 0) return ok({ queued: false, thresholdMet });
    const sent = await sendJobs(jobs);
    if (!sent.ok) return sent;
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
    const resolved = await pericopeRepo.resolvePericopes(params);
    if (!resolved.ok) return resolved;
    const data = resolved.data.groups.flatMap((group) => {
      if (!canSuggestPericopeTitle(resolved.data, group) || !group.suggestion) return [];
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
  user: Pick<User, 'id'>,
  data: PericopeUsageRequest
): Promise<Result<void>> {
  try {
    return await logPericopeUsage(user.id, data);
  } catch (error) {
    logger.error(error);
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
