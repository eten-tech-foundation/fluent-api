import { and, asc, eq, gt, inArray, isNull, not, sql } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import {
  ai_suggestion_usage_log,
  ai_suggestions,
  bible_texts,
  books,
  chapter_assignments,
  languages,
  project_units,
  projects,
  translated_verses,
} from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ProjectUnitAuthContext } from './ai-suggestions.policy';
import type { AiSuggestionItem, SuggestionContextResponse } from './ai-suggestions.types';

import { getContextBookCodes, getFtsConfig } from './ai-suggestions.constants';

export async function findProjectUnitAuthContext(
  projectUnitId: number
): Promise<ProjectUnitAuthContext | null> {
  const records = await db
    .select({
      organizationId: projects.organization,
      projectId: projects.id,
    })
    .from(project_units)
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .where(eq(project_units.id, projectUnitId))
    .limit(1);

  if (records.length === 0) return null;

  return {
    organizationId: records[0].organizationId,
    projectId: records[0].projectId,
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

// ─── Internal (machine-facing) repository functions ───────────────────────────

export async function getSuggestionContextData(
  projectUnitId: number,
  bibleId: number,
  targetBookCode: string,
  targetChapterNumber: number,
  targetVerseNumber: number,
  verseStart: number,
  verseEnd: number,
  limit: number
): Promise<Result<SuggestionContextResponse>> {
  // 1. Look up project languages
  const projectLangs = await db
    .select({
      sourceLanguage: projects.sourceLanguage,
      targetLanguage: projects.targetLanguage,
      organization: projects.organization,
    })
    .from(project_units)
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .where(eq(project_units.id, projectUnitId))
    .limit(1);

  if (!projectLangs[0]) {
    return err(ErrorCode.PROJECT_UNIT_NOT_FOUND);
  }

  const { sourceLanguage, targetLanguage, organization } = projectLangs[0];

  // 2. Resolve source language FTS config and target language name
  const [sourceLang, targetLang] = await Promise.all([
    db
      .select({ langCode: languages.langCodeIso6393 })
      .from(languages)
      .where(eq(languages.id, sourceLanguage))
      .limit(1),
    db
      .select({ langName: languages.langName })
      .from(languages)
      .where(eq(languages.id, targetLanguage))
      .limit(1),
  ]);

  const ftsConfig = getFtsConfig(sourceLang[0]?.langCode);
  const targetLanguageName = targetLang[0]?.langName || 'Unknown';

  // 3. Get target text
  const targetVerse = await db
    .select({ text: bible_texts.text })
    .from(bible_texts)
    .innerJoin(books, eq(bible_texts.bookId, books.id))
    .where(
      and(
        eq(bible_texts.bibleId, bibleId),
        eq(books.code, targetBookCode.toUpperCase()),
        eq(bible_texts.chapterNumber, targetChapterNumber),
        eq(bible_texts.verseNumber, targetVerseNumber)
      )
    )
    .limit(1);

  const targetText = targetVerse[0]?.text;

  let ftsRows: any[] = [];
  const MAX_CONTEXT_VERSES_FTS = 50;

  const baseWhere = and(
    eq(projects.targetLanguage, targetLanguage),
    eq(projects.sourceLanguage, sourceLanguage),
    eq(projects.organization, organization),
    eq(bible_texts.bibleId, bibleId),
    sql`${translated_verses.content} IS NOT NULL AND ${translated_verses.content} != ''`,
    not(
      and(
        eq(books.code, targetBookCode.toUpperCase()),
        eq(bible_texts.chapterNumber, targetChapterNumber),
        eq(bible_texts.verseNumber, targetVerseNumber)
      )!
    )
  );

  // 4A. FTS search
  if (targetText) {
    const ftsQuery = db
      .select({
        bibleTextId: bible_texts.id,
        bookCode: books.code,
        chapterNumber: bible_texts.chapterNumber,
        verseNumber: bible_texts.verseNumber,
        sourceText: bible_texts.text,
        targetText: translated_verses.content,
      })
      .from(translated_verses)
      .innerJoin(bible_texts, eq(translated_verses.bibleTextId, bible_texts.id))
      .innerJoin(books, eq(bible_texts.bookId, books.id))
      .innerJoin(project_units, eq(translated_verses.projectUnitId, project_units.id))
      .innerJoin(projects, eq(project_units.projectId, projects.id))
      .where(
        and(
          baseWhere,
          sql`to_tsvector(${ftsConfig}, ${bible_texts.text}) @@ plainto_tsquery(${ftsConfig}, ${targetText})`
        )
      )
      .orderBy(
        sql`ts_rank(to_tsvector(${ftsConfig}, ${bible_texts.text}), plainto_tsquery(${ftsConfig}, ${targetText})) DESC`
      )
      .limit(MAX_CONTEXT_VERSES_FTS);

    ftsRows = await ftsQuery;
  }

  const ftsBibleTextIds = ftsRows.map((r) => r.bibleTextId);

  // 4B. Proximity search
  const proxLimit = limit - ftsRows.length;
  let proxRows: any[] = [];

  if (proxLimit > 0) {
    let proxWhere = baseWhere;
    if (ftsBibleTextIds.length > 0) {
      proxWhere = and(proxWhere, not(inArray(bible_texts.id, ftsBibleTextIds)));
    }

    const targetGroup = getContextBookCodes(targetBookCode);

    const proxQuery = db
      .select({
        bibleTextId: bible_texts.id,
        bookCode: books.code,
        chapterNumber: bible_texts.chapterNumber,
        verseNumber: bible_texts.verseNumber,
        sourceText: bible_texts.text,
        targetText: translated_verses.content,
      })
      .from(translated_verses)
      .innerJoin(bible_texts, eq(translated_verses.bibleTextId, bible_texts.id))
      .innerJoin(books, eq(bible_texts.bookId, books.id))
      .innerJoin(project_units, eq(translated_verses.projectUnitId, project_units.id))
      .innerJoin(projects, eq(project_units.projectId, projects.id))
      .where(proxWhere)
      .orderBy(
        sql`CASE WHEN ${translated_verses.projectUnitId} = ${projectUnitId} THEN 0 ELSE 1 END`,
        sql`CASE WHEN ${books.code} = ${targetBookCode.toUpperCase()} THEN 0 WHEN ${inArray(books.code, targetGroup)} THEN 1 ELSE 2 END`,
        sql`ABS(${bible_texts.chapterNumber} - ${targetChapterNumber}) ASC`,
        sql`ABS(${bible_texts.verseNumber} - ${targetVerseNumber}) ASC`
      )
      .limit(proxLimit);

    proxRows = await proxQuery;
  }

  const combinedContext = [...ftsRows, ...proxRows].map((row) => ({
    verse_id: `${row.bookCode.toLowerCase()}_${row.chapterNumber}_${row.verseNumber}`,
    source_text: row.sourceText,
    target_text: row.targetText,
  }));

  const sourceVersesQuery = await db
    .select({
      id: bible_texts.id,
      verseNumber: bible_texts.verseNumber,
      text: bible_texts.text,
    })
    .from(bible_texts)
    .innerJoin(books, eq(bible_texts.bookId, books.id))
    .where(
      and(
        eq(bible_texts.bibleId, bibleId),
        eq(books.code, targetBookCode.toUpperCase()),
        eq(bible_texts.chapterNumber, targetChapterNumber),
        sql`${bible_texts.verseNumber} >= ${verseStart}`,
        sql`${bible_texts.verseNumber} <= ${verseEnd}`
      )
    )
    .orderBy(asc(bible_texts.verseNumber));

  const sourceVerses = sourceVersesQuery.map((v) => ({
    id: v.id,
    verse_number: v.verseNumber,
    text: v.text,
  }));

  return ok({
    targetLanguageName,
    contextVerses: combinedContext,
    sourceVerses,
  });
}

export async function upsertAiSuggestions(items: AiSuggestionItem[]): Promise<Result<void>> {
  if (items.length === 0) return ok(undefined);

  try {
    await db
      .insert(ai_suggestions)
      .values(items)
      .onConflictDoUpdate({
        target: [ai_suggestions.bibleTextId, ai_suggestions.projectUnitId],
        set: {
          suggestedText: sql`EXCLUDED.suggested_text`,
          modelInfo: sql`EXCLUDED.model_info`,
        },
      });

    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to upsert AI suggestions',
      context: { itemCount: items.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
