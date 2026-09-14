import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import {
  ai_pericope_suggestion_usage,
  ai_pericope_suggestions,
  ai_suggestions,
  bible_texts,
  books,
  chapter_assignments,
  pericope_verses,
  project_unit_bible_books,
  project_units,
  projects,
  translated_verses,
} from '@/db/schema';
import { getPericopeGroupNumber } from '@/domains/pericopes/pericopes.types';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  PericopeRequest,
  PericopeSuggestionItem,
  PericopeUsageRequest,
} from './ai-suggestions.types';

export interface PericopeVerse {
  bibleTextId: number;
  verseNumber: number;
  content: string | null;
  hasAuthoredHeading: boolean;
  hasSuggestion: boolean;
}
export interface ResolvedPericope {
  pericopeNumber: string;
  sourceTitle: string | null;
  verses: PericopeVerse[];
  suggestion: typeof ai_pericope_suggestions.$inferSelect | null;
}
export interface PericopeContext {
  pericopeSetId: number;
  isAiEnabled: boolean;
  groups: ResolvedPericope[];
}

/** Resolve exact source-backed verses from the project's current set, never a client range. */
export async function resolvePericopes(params: PericopeRequest): Promise<Result<PericopeContext>> {
  return resolvePericopesForSet(params);
}

/** Resolve against an explicit set when accepting a result from an already queued job. */
async function resolvePericopesForSet(
  params: PericopeRequest,
  requestedPericopeSetId?: number
): Promise<Result<PericopeContext>> {
  const [context] = await db
    .select({
      pericopeSetId: projects.pericopeSetId,
      isAiEnabled: chapter_assignments.isAiEnabled,
      bookId: books.id,
    })
    .from(project_units)
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .innerJoin(
      project_unit_bible_books,
      eq(project_unit_bible_books.projectUnitId, project_units.id)
    )
    .innerJoin(books, eq(project_unit_bible_books.bookId, books.id))
    .innerJoin(
      chapter_assignments,
      and(
        eq(chapter_assignments.projectUnitId, project_units.id),
        eq(chapter_assignments.bibleId, project_unit_bible_books.bibleId),
        eq(chapter_assignments.bookId, books.id),
        eq(chapter_assignments.chapterNumber, params.chapterNumber)
      )
    )
    .where(
      and(
        eq(project_units.id, params.projectUnitId),
        eq(project_unit_bible_books.bibleId, params.bibleId),
        eq(books.code, params.bookCode.toUpperCase())
      )
    )
    .limit(1);
  if (!context) return err(ErrorCode.INVALID_REFERENCE);
  const pericopeSetId = requestedPericopeSetId ?? context.pericopeSetId;
  if (!pericopeSetId) return err(ErrorCode.INVALID_REFERENCE);

  const rows = await db
    .select({
      pericopeNumber: pericope_verses.pericopeNumber,
      section: pericope_verses.section,
      sourceTitle: pericope_verses.pericopeTitle,
      bibleTextId: bible_texts.id,
      verseNumber: bible_texts.verseNumber,
      content: translated_verses.content,
      markers: translated_verses.markers,
      suggestionId: ai_suggestions.id,
    })
    .from(pericope_verses)
    .innerJoin(
      bible_texts,
      and(
        eq(bible_texts.bibleId, params.bibleId),
        eq(bible_texts.bookId, pericope_verses.bookId),
        eq(bible_texts.chapterNumber, pericope_verses.chapterNumber),
        eq(bible_texts.verseNumber, pericope_verses.verseNumber)
      )
    )
    .leftJoin(
      translated_verses,
      and(
        eq(translated_verses.bibleTextId, bible_texts.id),
        eq(translated_verses.projectUnitId, params.projectUnitId)
      )
    )
    .leftJoin(
      ai_suggestions,
      and(
        eq(ai_suggestions.bibleTextId, bible_texts.id),
        eq(ai_suggestions.projectUnitId, params.projectUnitId)
      )
    )
    .where(
      and(
        eq(pericope_verses.pericopeSetId, pericopeSetId),
        eq(pericope_verses.bookId, context.bookId),
        eq(pericope_verses.chapterNumber, params.chapterNumber)
      )
    )
    .orderBy(asc(bible_texts.verseNumber));

  const groups: ResolvedPericope[] = params.pericopeNumbers.map((pericopeNumber) => {
    const verses = rows.filter((row) => getPericopeGroupNumber(row) === pericopeNumber);
    return {
      pericopeNumber,
      sourceTitle: verses.find((row) => row.sourceTitle?.trim())?.sourceTitle?.trim() ?? null,
      verses: verses.map((row) => ({
        bibleTextId: row.bibleTextId,
        verseNumber: row.verseNumber,
        content: row.content,
        hasAuthoredHeading: Boolean(row.markers?.headings?.length),
        hasSuggestion: row.suggestionId !== null,
      })),
      suggestion: null,
    };
  });
  // Reject the complete batch if any number is outside this chapter/book/set.
  if (groups.some((group) => group.verses.length === 0)) return err(ErrorCode.INVALID_REFERENCE);

  const suggestions = await db
    .select()
    .from(ai_pericope_suggestions)
    .where(
      and(
        eq(ai_pericope_suggestions.projectUnitId, params.projectUnitId),
        eq(ai_pericope_suggestions.bibleId, params.bibleId),
        eq(ai_pericope_suggestions.pericopeSetId, pericopeSetId),
        eq(ai_pericope_suggestions.bookId, context.bookId),
        eq(ai_pericope_suggestions.chapterNumber, params.chapterNumber),
        inArray(ai_pericope_suggestions.pericopeNumber, params.pericopeNumbers)
      )
    );
  for (const group of groups) {
    group.suggestion =
      suggestions.find((suggestion) => suggestion.pericopeNumber === group.pericopeNumber) ?? null;
  }
  return ok({ pericopeSetId, isAiEnabled: context.isAiEnabled, groups });
}

export async function savePericopeSuggestion(item: PericopeSuggestionItem): Promise<Result<void>> {
  const [verse] = await db
    .select({
      bibleId: bible_texts.bibleId,
      bookId: bible_texts.bookId,
      bookCode: books.code,
      chapterNumber: bible_texts.chapterNumber,
    })
    .from(bible_texts)
    .innerJoin(books, eq(books.id, bible_texts.bookId))
    .where(eq(bible_texts.id, item.bibleTextId))
    .limit(1);
  if (!verse) return err(ErrorCode.INVALID_REFERENCE);
  const resolved = await resolvePericopesForSet(
    {
      ...verse,
      projectUnitId: item.projectUnitId,
      pericopeNumbers: [item.pericopeNumber],
    },
    item.pericopeSetId
  );
  if (!resolved.ok) return resolved;
  const group = resolved.data.groups[0];
  if (!group.verses.some((verse) => verse.bibleTextId === item.bibleTextId)) {
    return err(ErrorCode.INVALID_REFERENCE);
  }
  // A drafter may have written a heading while the model was generating.
  if (!resolved.data.isAiEnabled || !group.sourceTitle || group.verses[0].hasAuthoredHeading)
    return ok(undefined);
  await db
    .insert(ai_pericope_suggestions)
    .values({
      ...item,
      bibleId: verse.bibleId,
      bookId: verse.bookId,
      chapterNumber: verse.chapterNumber,
    })
    .onConflictDoNothing();
  return ok(undefined);
}

export async function logPericopeUsage(
  userId: number,
  data: PericopeUsageRequest
): Promise<Result<void>> {
  const [verse] = await db
    .select({
      bibleId: bible_texts.bibleId,
      bookCode: books.code,
      chapterNumber: bible_texts.chapterNumber,
    })
    .from(bible_texts)
    .innerJoin(books, eq(books.id, bible_texts.bookId))
    .where(eq(bible_texts.id, data.bibleTextId))
    .limit(1);
  if (!verse) return err(ErrorCode.INVALID_REFERENCE);
  const resolved = await resolvePericopes({
    ...verse,
    projectUnitId: data.projectUnitId,
    pericopeNumbers: [data.pericopeNumber],
  });
  if (!resolved.ok) return resolved;
  const group = resolved.data.groups[0];
  if (group.verses[0].bibleTextId !== data.bibleTextId || !group.suggestion) {
    return err(ErrorCode.INVALID_REFERENCE);
  }
  await db
    .insert(ai_pericope_suggestion_usage)
    .values({ suggestionId: group.suggestion.id, userId, wasUsed: data.wasUsed })
    .onConflictDoUpdate({
      target: [ai_pericope_suggestion_usage.suggestionId, ai_pericope_suggestion_usage.userId],
      // A late exposure request must never downgrade a previously accepted title.
      set: { wasUsed: sql`${ai_pericope_suggestion_usage.wasUsed} OR EXCLUDED.was_used` },
    });
  return ok(undefined);
}
