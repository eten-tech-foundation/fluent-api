import type { AiSuggestionTriggerJob } from '@/lib/queue';
import type { Result, User } from '@/lib/types';

import env from '@/env';
import { logger } from '@/lib/logger';
import { getQueue, QUEUE_NAMES } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  PericopeContext,
  PericopeRequest,
  PericopeSuggestionItem,
  PericopeSuggestionsResponse,
  PericopeUsageRequest,
  QueueNextVersesResponse,
  ResolvedPericope,
} from './ai-suggestions.types';

import * as pericopeRepo from './ai-pericope.repository';
import * as suggestionsRepo from './ai-suggestions.repository';

export function canSuggestPericopeTitle(
  context: PericopeContext,
  group: ResolvedPericope
): boolean {
  return Boolean(
    context.isAiEnabled &&
      group.startsPericope &&
      group.sourceTitle &&
      group.verses.length &&
      !group.verses[0].hasAuthoredHeading
  );
}

export async function savePericopeSuggestion(
  heading: PericopeSuggestionItem
): Promise<Result<void>> {
  const verse = await pericopeRepo.findPericopeVerse(heading.bibleTextId);
  if (!verse) return err(ErrorCode.INVALID_REFERENCE);
  const resolved = await pericopeRepo.resolvePericopes(
    {
      ...verse,
      projectUnitId: heading.projectUnitId,
      pericopeNumbers: [heading.pericopeNumber],
    },
    heading.pericopeSetId
  );
  if (!resolved.ok) return resolved;
  const group = resolved.data.groups[0];
  if (!group.verses.some((v) => v.bibleTextId === heading.bibleTextId))
    return err(ErrorCode.INVALID_REFERENCE);
  if (!canSuggestPericopeTitle(resolved.data, group)) return ok(undefined);
  await pericopeRepo.insertPericopeSuggestion(heading, verse);
  return ok(undefined);
}

async function logPericopeUsage(userId: number, data: PericopeUsageRequest): Promise<Result<void>> {
  const verse = await pericopeRepo.findPericopeVerse(data.bibleTextId);
  if (!verse) return err(ErrorCode.INVALID_REFERENCE);
  const saved = await pericopeRepo.findSavedPericopeSets(data, verse);
  // A visible old-set title can still be accepted after the project's set changes.
  // Prefer a cached title from the current set, otherwise use the newest saved set.
  const selected = saved.find((row) => row.pericopeSetId === row.currentPericopeSetId) ?? saved[0];
  const resolved = await pericopeRepo.resolvePericopes(
    {
      ...verse,
      projectUnitId: data.projectUnitId,
      pericopeNumbers: [data.pericopeNumber],
    },
    selected?.pericopeSetId
  );
  if (!resolved.ok) return resolved;
  const group = resolved.data.groups[0];
  if (
    !group.startsPericope ||
    group.verses[0].bibleTextId !== data.bibleTextId ||
    !group.suggestion
  )
    return err(ErrorCode.INVALID_REFERENCE);
  await pericopeRepo.upsertPericopeUsage(userId, group.suggestion.id, data.wasUsed);
  return ok(undefined);
}

export async function queuePericopes(
  params: PericopeRequest
): Promise<Result<QueueNextVersesResponse>> {
  try {
    const resolved = await pericopeRepo.resolvePericopes(params);
    if (!resolved.ok) return resolved;
    const thresholdMet = await suggestionsRepo.hasReachedAiActivationThreshold(
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
      if (canSuggestPericopeTitle(resolved.data, group) && !group.suggestion) {
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
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
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
