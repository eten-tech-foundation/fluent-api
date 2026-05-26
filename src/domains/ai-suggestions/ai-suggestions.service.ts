import { and, asc, count, eq, gt, inArray, isNull } from 'drizzle-orm';

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
import { logger } from '@/lib/logger';
import { ROLES } from '@/lib/roles';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  AiSuggestionsListResponse,
  GetAiSuggestionsQuery,
  TrackUsageRequest,
} from './ai-suggestions.types';

import { AI_SUGGESTIONS_CONSTANTS } from './ai-suggestions.constants';
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

async function chapterBelongsToProjectUnit(input: {
  projectUnitId: number;
  bibleId: number;
  bookCode: string;
  chapterNumber: number;
}): Promise<boolean> {
  const [record] = await db
    .select({ id: chapter_assignments.id })
    .from(chapter_assignments)
    .innerJoin(books, eq(chapter_assignments.bookId, books.id))
    .where(
      and(
        eq(chapter_assignments.projectUnitId, input.projectUnitId),
        eq(chapter_assignments.bibleId, input.bibleId),
        eq(books.code, input.bookCode),
        eq(chapter_assignments.chapterNumber, input.chapterNumber)
      )
    )
    .limit(1);

  return Boolean(record);
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
    ids.length > AI_SUGGESTIONS_CONSTANTS.MAX_REQUESTED_BIBLE_TEXT_IDS ||
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
  lookahead: number = AI_SUGGESTIONS_CONSTANTS.DEFAULT_LOOKAHEAD
): Promise<Result<void>> {
  try {
    if (!(await userCanAccessProjectUnit(user, projectUnitId))) {
      return err(ErrorCode.FORBIDDEN);
    }

    const normalizedBookCode = bookCode.toUpperCase();

    if (
      !(await chapterBelongsToProjectUnit({
        projectUnitId,
        bibleId,
        bookCode: normalizedBookCode,
        chapterNumber,
      }))
    ) {
      return err(ErrorCode.INVALID_REFERENCE);
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
    const unit = await db
      .select({ isAiEnabled: project_units.isAiEnabled })
      .from(project_units)
      .where(eq(project_units.id, projectUnitId))
      .limit(1);

    if (!unit[0]?.isAiEnabled) return;

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
      AI_SUGGESTIONS_CONSTANTS.INITIAL_QUEUE_COUNT
    );
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to trigger initial AI queue on chapter assignment',
      context: { projectUnitId, chapterNumber },
    });
  }
}

export async function handleVerseSaved(projectUnitId: number) {
  try {
    // 1. Check if AI is already enabled
    const unit = await db
      .select({ isAiEnabled: project_units.isAiEnabled })
      .from(project_units)
      .where(eq(project_units.id, projectUnitId))
      .limit(1);

    if (!unit[0] || unit[0].isAiEnabled) return;

    // 2. Count translated verses for this unit
    const result = await db
      .select({ value: count() })
      .from(translated_verses)
      .where(eq(translated_verses.projectUnitId, projectUnitId));

    const verseCount = result[0]?.value ?? 0;

    if (verseCount >= AI_SUGGESTIONS_CONSTANTS.ACTIVATION_THRESHOLD_VERSES) {
      // 3. Mark AI as enabled
      await db
        .update(project_units)
        .set({ isAiEnabled: true })
        .where(eq(project_units.id, projectUnitId));

      // 4. Batch queue verses for all assigned chapters concurrently
      const assignments = await db
        .select({
          bibleId: chapter_assignments.bibleId,
          bookId: chapter_assignments.bookId,
          chapterNumber: chapter_assignments.chapterNumber,
          bookCode: books.code,
        })
        .from(chapter_assignments)
        .innerJoin(books, eq(chapter_assignments.bookId, books.id))
        .where(eq(chapter_assignments.projectUnitId, projectUnitId));

      const queueResults = await Promise.all(
        assignments.map(
          (assignment: {
            bibleId: number;
            bookId: number;
            chapterNumber: number;
            bookCode: string;
          }) =>
            queueNextVersesForAssignment(
              projectUnitId,
              assignment.bibleId,
              assignment.bookCode.toLowerCase(),
              assignment.chapterNumber,
              0,
              AI_SUGGESTIONS_CONSTANTS.INITIAL_QUEUE_COUNT
            )
        )
      );

      // 5. If any queueing failed, revert the flag so we can try again later
      if (queueResults.some((r: Result<void>) => !r.ok)) {
        await db
          .update(project_units)
          .set({ isAiEnabled: false })
          .where(eq(project_units.id, projectUnitId));
        throw new Error(
          'Failed to batch queue initial AI suggestions. Rolled back threshold state.'
        );
      }

      logger.info({ projectUnitId }, 'AI Suggestions threshold reached and enabled.');
    }
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Threshold check failed',
      context: { projectUnitId },
    });
  }
}
