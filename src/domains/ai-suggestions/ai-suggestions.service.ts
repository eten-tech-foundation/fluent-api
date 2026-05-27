import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';

import type { Result, User } from '@/lib/types';

import { db } from '@/db';
import {
  bible_texts,
  books,
  chapter_assignments,
  project_units,
  project_users,
  projects,
  translated_verses,
} from '@/db/schema';
import env from '@/env';
import { logger } from '@/lib/logger';
import { ROLES } from '@/lib/roles';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  AiSuggestionsListResponse,
  GetAiSuggestionsQuery,
  TrackUsageRequest,
} from './ai-suggestions.types';

import {
  getAiSuggestions as getAiSuggestionsRepo,
  logAiSuggestionUsage,
  queueAiSuggestionJobs,
} from './ai-suggestions.repository';

async function userCanAccessProjectUnit(user: User, projectUnitId: number): Promise<boolean> {
  const [record] = await db
    .select({
      organization: projects.organization,
      memberUserId: project_users.userId,
    })
    .from(project_units)
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .leftJoin(
      project_users,
      and(eq(project_users.projectId, projects.id), eq(project_users.userId, user.id))
    )
    .where(eq(project_units.id, projectUnitId))
    .limit(1);

  if (!record) return false;

  if (user.roleName === ROLES.PROJECT_MANAGER) {
    return record.organization === user.organization;
  }

  if (user.roleName === ROLES.TRANSLATOR) {
    return record.memberUserId === user.id;
  }

  return false;
}

export async function trackUsage(user: User, data: TrackUsageRequest): Promise<Result<void>> {
  if (!(await userCanAccessProjectUnit(user, data.projectUnitId))) {
    return err(ErrorCode.FORBIDDEN);
  }

  return logAiSuggestionUsage(user.id, data.bibleTextId, data.projectUnitId, data.wasUsed);
}

export async function getAiSuggestions(
  user: User,
  query: GetAiSuggestionsQuery
): Promise<Result<AiSuggestionsListResponse>> {
  const ids = query.bibleTextIds
    .split(',')
    .map((id) => Number.parseInt(id.trim(), 10))
    .filter((id) => !Number.isNaN(id));

  if (
    ids.length === 0 ||
    ids.length > env.AI_MAX_REQUESTED_BIBLE_TEXT_IDS ||
    ids.length !== new Set(ids).size
  ) {
    return err(ErrorCode.VALIDATION_ERROR);
  }

  if (!(await userCanAccessProjectUnit(user, query.projectUnitId))) {
    return err(ErrorCode.FORBIDDEN);
  }

  const existingIds = await db
    .select({ id: bible_texts.id })
    .from(bible_texts)
    .where(inArray(bible_texts.id, ids));

  if (existingIds.length !== ids.length) {
    return err(ErrorCode.VALIDATION_ERROR);
  }

  const suggestionsResult = await getAiSuggestionsRepo(query.projectUnitId, ids);

  if (!suggestionsResult.ok) {
    return suggestionsResult;
  }

  const data = suggestionsResult.data.map(
    (suggestion: { bibleTextId: number; suggestedText: string; modelInfo: string | null }) => ({
      bibleTextId: suggestion.bibleTextId,
      suggestedText: suggestion.suggestedText,
      modelInfo: suggestion.modelInfo,
    })
  );

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
    if (!(await userCanAccessProjectUnit(user, projectUnitId))) {
      return err(ErrorCode.FORBIDDEN);
    }

    const normalizedBookCode = bookCode.toUpperCase();

    const assignment = await db
      .select({ isAiEnabled: chapter_assignments.isAiEnabled })
      .from(chapter_assignments)
      .innerJoin(books, eq(chapter_assignments.bookId, books.id))
      .where(
        and(
          eq(chapter_assignments.projectUnitId, projectUnitId),
          eq(chapter_assignments.bibleId, bibleId),
          eq(books.code, normalizedBookCode),
          eq(chapter_assignments.chapterNumber, chapterNumber)
        )
      )
      .limit(1);

    if (!assignment[0]) {
      return err(ErrorCode.INVALID_REFERENCE);
    }

    if (!assignment[0].isAiEnabled) {
      return ok(undefined);
    }

    return await queueNextVersesForAssignment(
      projectUnitId,
      bibleId,
      normalizedBookCode,
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
  const nextVerses = await db
    .select({ verseNumber: bible_texts.verseNumber })
    .from(bible_texts)
    .innerJoin(books, eq(bible_texts.bookId, books.id))
    .leftJoin(
      translated_verses,
      and(
        eq(translated_verses.bibleTextId, bible_texts.id),
        eq(translated_verses.projectUnitId, projectUnitId)
      )
    )
    .where(
      and(
        eq(bible_texts.bibleId, bibleId),
        eq(books.code, bookCode),
        eq(bible_texts.chapterNumber, chapterNumber),
        gt(bible_texts.verseNumber, currentVerse),
        isNull(translated_verses.projectUnitId)
      )
    )
    .orderBy(asc(bible_texts.verseNumber))
    .limit(lookahead);

  if (nextVerses.length === 0) return ok(undefined);

  const jobs = nextVerses.map((v) => ({
    projectUnitId,
    bibleId,
    bookCode,
    chapterNumber,
    verseStart: v.verseNumber,
    verseEnd: v.verseNumber,
  }));

  return queueAiSuggestionJobs(jobs);
}

export async function handleChapterAssigned(
  projectUnitId: number,
  bibleId: number,
  bookId: number,
  chapterNumber: number
) {
  try {
    const assignment = await db
      .select({ isAiEnabled: chapter_assignments.isAiEnabled })
      .from(chapter_assignments)
      .where(
        and(
          eq(chapter_assignments.projectUnitId, projectUnitId),
          eq(chapter_assignments.bibleId, bibleId),
          eq(chapter_assignments.bookId, bookId),
          eq(chapter_assignments.chapterNumber, chapterNumber)
        )
      )
      .limit(1);

    if (!assignment[0]?.isAiEnabled) return;

    const book = await db
      .select({ code: books.code })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    if (!book[0]?.code) return;

    await queueNextVersesForAssignment(
      projectUnitId,
      bibleId,
      book[0].code.toUpperCase(),
      chapterNumber,
      0,
      env.AI_INITIAL_QUEUE_COUNT
    );
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to trigger initial AI queue on chapter assignment',
      context: { projectUnitId, chapterNumber },
    });
  }
}
