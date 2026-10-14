import { and, asc, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { bible_texts, bibles, books, languages, pericope_verses, projects } from '@/db/schema';

import type { SourceVerse } from './assistant.prompt';

export interface PassageContext {
  sourceBible: string;
  sourceLanguageCode: string;
  verses: SourceVerse[];
}

async function resolveExactSourceVerse(input: {
  sourceBibleId: number;
  bookId: number;
  bookCode: string;
  chapter: number;
  verse: number;
}): Promise<SourceVerse | null> {
  const rows = await db
    .select({
      chapter: bible_texts.chapterNumber,
      verse: bible_texts.verseNumber,
      text: bible_texts.text,
    })
    .from(bible_texts)
    .where(
      and(
        eq(bible_texts.bibleId, input.sourceBibleId),
        eq(bible_texts.bookId, input.bookId),
        eq(bible_texts.chapterNumber, input.chapter),
        eq(bible_texts.verseNumber, input.verse)
      )
    );
  if (rows.length !== 1) return null;
  return { bookCode: input.bookCode, ...rows[0] };
}

/** Resolve a complete canonical pericope from the project's selected source Bible. */
export async function resolveCanonicalPassage(input: {
  projectId: number;
  bookCode: string;
  chapter: number;
  activeVerse: number;
}): Promise<PassageContext | null> {
  const [project] = await db
    .select({
      sourceBibleId: projects.sourceBibleId,
      pericopeSetId: projects.pericopeSetId,
      sourceBible: bibles.name,
      sourceLanguageCode: languages.langCodeIso6393,
    })
    .from(projects)
    .innerJoin(bibles, eq(bibles.id, projects.sourceBibleId))
    .innerJoin(languages, eq(languages.id, projects.sourceLanguage))
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project?.sourceBibleId || !project.sourceLanguageCode) return null;

  const [book] = await db
    .select({ id: books.id, code: books.code })
    .from(books)
    .where(eq(books.code, input.bookCode.toUpperCase()))
    .limit(1);
  if (!book) return null;

  if (project.pericopeSetId) {
    const memberships = await db
      .select({ number: pericope_verses.pericopeNumber, section: pericope_verses.section })
      .from(pericope_verses)
      .where(
        and(
          eq(pericope_verses.pericopeSetId, project.pericopeSetId),
          eq(pericope_verses.bookId, book.id),
          eq(pericope_verses.chapterNumber, input.chapter),
          eq(pericope_verses.verseNumber, input.activeVerse)
        )
      );
    if (memberships.length > 1) return null;
    if (memberships.length === 0) {
      const verse = await resolveExactSourceVerse({
        sourceBibleId: project.sourceBibleId,
        bookId: book.id,
        bookCode: book.code,
        chapter: input.chapter,
        verse: input.activeVerse,
      });
      return verse
        ? {
            sourceBible: project.sourceBible,
            sourceLanguageCode: project.sourceLanguageCode,
            verses: [verse],
          }
        : null;
    }
    const membership = memberships[0];
    const expected = await db
      .select({ chapter: pericope_verses.chapterNumber, verse: pericope_verses.verseNumber })
      .from(pericope_verses)
      .where(
        and(
          eq(pericope_verses.pericopeSetId, project.pericopeSetId),
          eq(pericope_verses.bookId, book.id),
          eq(pericope_verses.pericopeNumber, membership.number),
          sql`${pericope_verses.section} IS NOT DISTINCT FROM ${membership.section}`
        )
      )
      .orderBy(asc(pericope_verses.chapterNumber), asc(pericope_verses.verseNumber));
    const source = await db
      .select({
        chapter: bible_texts.chapterNumber,
        verse: bible_texts.verseNumber,
        text: bible_texts.text,
      })
      .from(bible_texts)
      .where(and(eq(bible_texts.bibleId, project.sourceBibleId), eq(bible_texts.bookId, book.id)))
      .orderBy(asc(bible_texts.chapterNumber), asc(bible_texts.verseNumber));
    const byReference = new Map<string, typeof source>();
    for (const row of source) {
      const key = `${row.chapter}:${row.verse}`;
      byReference.set(key, [...(byReference.get(key) ?? []), row]);
    }
    const verses: SourceVerse[] = [];
    for (const ref of expected) {
      const matches = byReference.get(`${ref.chapter}:${ref.verse}`) ?? [];
      if (matches.length !== 1) return null;
      verses.push({
        bookCode: book.code,
        chapter: ref.chapter,
        verse: ref.verse,
        text: matches[0].text,
      });
    }
    if (!verses.length) return null;
    return {
      sourceBible: project.sourceBible,
      sourceLanguageCode: project.sourceLanguageCode,
      verses,
    };
  }

  const verse = await resolveExactSourceVerse({
    sourceBibleId: project.sourceBibleId,
    bookId: book.id,
    bookCode: book.code,
    chapter: input.chapter,
    verse: input.activeVerse,
  });
  return verse
    ? {
        sourceBible: project.sourceBible,
        sourceLanguageCode: project.sourceLanguageCode,
        verses: [verse],
      }
    : null;
}

export async function findProjectSourceLanguage(projectId: number): Promise<string | null> {
  const [row] = await db
    .select({ code: languages.langCodeIso6393 })
    .from(projects)
    .innerJoin(languages, eq(languages.id, projects.sourceLanguage))
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.code ?? null;
}
