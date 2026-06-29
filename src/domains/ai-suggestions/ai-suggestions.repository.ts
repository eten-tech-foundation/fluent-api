import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import {
  ai_suggestion_usage_log,
  ai_suggestions,
  bible_texts,
  books,
  chapter_assignments,
  project_units,
  project_users,
  projects,
  translated_verses,
} from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ProjectUnitAuthContext } from './ai-suggestions.policy';

export async function findProjectUnitAuthContext(
  projectUnitId: number
): Promise<ProjectUnitAuthContext | null> {
  const records = await db
    .select({
      organizationId: projects.organization,
      memberUserId: project_users.userId,
    })
    .from(project_units)
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .leftJoin(project_users, eq(project_users.projectId, projects.id))
    .where(eq(project_units.id, projectUnitId));

  if (records.length === 0) return null;

  return {
    organizationId: records[0].organizationId,
    memberUserIds: records.map((r) => r.memberUserId).filter((id): id is number => id !== null),
  };
}

export async function checkBibleTextsExist(ids: number[]): Promise<boolean> {
  if (ids.length === 0) return true;

  const existingIds = await db
    .select({ id: bible_texts.id })
    .from(bible_texts)
    .where(inArray(bible_texts.id, ids));

  return existingIds.length === ids.length;
}

export async function getChapterAssignmentAiStatus(
  projectUnitId: number,
  bibleId: number,
  bookCode: string,
  chapterNumber: number
): Promise<boolean | null> {
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

  if (!assignment[0]) return null;
  return assignment[0].isAiEnabled;
}

export async function getBookCodeById(bookId: number): Promise<string | null> {
  const book = await db
    .select({ code: books.code })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  return book[0]?.code ?? null;
}

export async function getAiSuggestions(
  projectUnitId: number,
  bibleTextIds: number[],
  tx?: DbTransaction
) {
  const database = tx || db;
  try {
    if (bibleTextIds.length === 0) return ok([]);

    const results = await database
      .select()
      .from(ai_suggestions)
      .where(
        and(
          eq(ai_suggestions.projectUnitId, projectUnitId),
          inArray(ai_suggestions.bibleTextId, bibleTextIds)
        )
      );

    return ok(results);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to fetch AI suggestions',
      context: { projectUnitId, textIdsCount: bibleTextIds.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function logAiSuggestionUsage(
  userId: number,
  bibleTextId: number,
  projectUnitId: number,
  wasUsed: boolean,
  tx?: DbTransaction
): Promise<Result<void>> {
  const database = tx || db;
  try {
    await database
      .insert(ai_suggestion_usage_log)
      .values({
        userId,
        bibleTextId,
        projectUnitId,
        wasUsed,
      })
      .onConflictDoUpdate({
        target: [
          ai_suggestion_usage_log.userId,
          ai_suggestion_usage_log.bibleTextId,
          ai_suggestion_usage_log.projectUnitId,
        ],
        set: { wasUsed }, // Update if the user later accepts it
      });

    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to log AI suggestion usage',
      context: { userId, bibleTextId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findNextUntranslatedVerses(
  projectUnitId: number,
  bibleId: number,
  bookCode: string,
  chapterNumber: number,
  currentVerse: number,
  lookahead: number
): Promise<number[]> {
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

  return nextVerses.map((v) => v.verseNumber);
}

export async function hasReachedAiActivationThreshold(
  projectUnitId: number,
  threshold: number
): Promise<boolean> {
  const projectInfo = await db
    .select({
      sourceLanguage: projects.sourceLanguage,
      targetLanguage: projects.targetLanguage,
      organization: projects.organization,
    })
    .from(project_units)
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .where(eq(project_units.id, projectUnitId))
    .limit(1);

  if (!projectInfo[0]) return false;

  const { sourceLanguage, targetLanguage, organization } = projectInfo[0];

  const result = await db
    .select({ id: translated_verses.id })
    .from(translated_verses)
    .innerJoin(project_units, eq(translated_verses.projectUnitId, project_units.id))
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .where(
      and(
        eq(projects.sourceLanguage, sourceLanguage),
        eq(projects.targetLanguage, targetLanguage),
        eq(projects.organization, organization),
        sql`length(trim(${translated_verses.content})) > 0`
      )
    )
    .limit(1)
    .offset(threshold - 1);

  return result.length > 0;
}
