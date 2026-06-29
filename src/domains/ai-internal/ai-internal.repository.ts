import { and, asc, case as sqlCase, desc, eq, inArray, not, sql } from 'drizzle-orm';

import { db } from '@/db';
import { ai_suggestions, bible_texts, books, languages, project_units, projects, translated_verses } from '@/db/schema';
import { logger } from '@/lib/logger';

const POSTGRES_FTS_LANGUAGES: Record<string, string> = {
  eng: 'english',
  en: 'english',
  spa: 'spanish',
  es: 'spanish',
  fre: 'french',
  fra: 'french',
  fr: 'french',
  ger: 'german',
  deu: 'german',
  de: 'german',
  ita: 'italian',
  it: 'italian',
  por: 'portuguese',
  pt: 'portuguese',
  rus: 'russian',
  ru: 'russian',
  hin: 'simple',
  guj: 'simple',
  mar: 'simple',
  ben: 'simple',
  tam: 'simple',
};

function getFtsConfig(languageCode: string | null): string {
  if (!languageCode) return 'simple';
  return POSTGRES_FTS_LANGUAGES[languageCode.toLowerCase()] || 'simple';
}

const CONTEXT_BOOK_CODES: Record<string, string[]> = {
  // Add mapping logic if needed, simplify for now by using order
  // E.g. Gospels, Epistles, etc. (Can just use default if complex)
};

export async function getSuggestionContextData(
  projectUnitId: number,
  bibleId: number,
  targetBookCode: string,
  targetChapterNumber: number,
  targetVerseNumber: number,
  verseStart: number,
  verseEnd: number,
  limit: number
) {
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
    throw new Error('Project languages not found');
  }

  const { sourceLanguage, targetLanguage, organization } = projectLangs[0];

  // 2. Resolve source language FTS config and target language name
  const [sourceLang, targetLang] = await Promise.all([
    db.select({ langCode: languages.langCodeIso6393 }).from(languages).where(eq(languages.id, sourceLanguage)).limit(1),
    db.select({ langName: languages.langName }).from(languages).where(eq(languages.id, targetLanguage)).limit(1),
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
      )
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
      .orderBy(sql`ts_rank(to_tsvector(${ftsConfig}, ${bible_texts.text}), plainto_tsquery(${ftsConfig}, ${targetText})) DESC`)
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
        sqlCase().when(eq(translated_verses.projectUnitId, projectUnitId), 0).else(1),
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
    );

  const sourceVerses = sourceVersesQuery.map((v) => ({
    id: v.id,
    verse_number: v.verseNumber,
    text: v.text,
  }));

  return {
    targetLanguageName,
    contextVerses: combinedContext,
    sourceVerses,
  };
}

export async function upsertAiSuggestions(items: { bibleTextId: number; projectUnitId: number; suggestedText: string; modelInfo?: string }[]) {
  if (items.length === 0) return;

  await db.insert(ai_suggestions).values(items).onConflictDoUpdate({
    target: [ai_suggestions.bibleTextId, ai_suggestions.projectUnitId],
    set: {
      suggestedText: sql`EXCLUDED.suggested_text`,
      modelInfo: sql`EXCLUDED.model_info`,
    }
  });
}

export async function getSourceVerses(bibleId: number, bookCode: string, chapterNumber: number, verseStart: number, verseEnd: number) {
  return db
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
        eq(books.code, bookCode.toUpperCase()),
        eq(bible_texts.chapterNumber, chapterNumber),
        sql`${bible_texts.verseNumber} >= ${verseStart}`,
        sql`${bible_texts.verseNumber} <= ${verseEnd}`
      )
    );
}
