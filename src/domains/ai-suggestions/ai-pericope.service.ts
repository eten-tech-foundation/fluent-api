import type { Result } from '@/lib/types';

import { err, ErrorCode, ok } from '@/lib/types';

import type {
  PericopeContext,
  PericopeSuggestionItem,
  PericopeUsageRequest,
  ResolvedPericope,
} from './ai-suggestions.types';

import * as pericopeRepo from './ai-pericope.repository';

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
  if (!group.verses.some((verse) => verse.bibleTextId === heading.bibleTextId))
    return err(ErrorCode.INVALID_REFERENCE);
  if (!canSuggestPericopeTitle(resolved.data, group)) return ok(undefined);
  await pericopeRepo.insertPericopeSuggestion(heading, verse);
  return ok(undefined);
}

export async function logPericopeUsage(
  userId: number,
  data: PericopeUsageRequest
): Promise<Result<void>> {
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
