import { and, eq, inArray } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';
import type { UsjVerseText } from '@/lib/usfm-converter';

import { db } from '@/db';
import { bible_texts, books, translated_verses } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';
import { convertUSFMToUSJ, usjToVerseTexts } from '@/lib/usfm-converter';

import type { UsfmFileInput } from './projects.types';

import * as repo from './projects.repository';

export interface ParsedUsfmFile extends UsfmFileInput {
  bookId: number;
  verses: UsjVerseText[];
}

/**
 * Re-validates every file server-side before anything is written, so one bad file rejects the
 * whole import (#418's rule, not trusted from the client). The book each file claims must be a
 * real book and must match the `\id` the file actually carries; the ids that come back are what
 * the project is created with, since the files are the authority on which books exist.
 */
export async function parseUsfmFiles(files: UsfmFileInput[]): Promise<Result<ParsedUsfmFile[]>> {
  const claimed = files.map((file) => file.bookCode.trim().toUpperCase());
  if (new Set(claimed).size !== claimed.length) {
    return err(ErrorCode.USFM_BOOK_MISMATCH);
  }

  const known = await db
    .select({ id: books.id, code: books.code })
    .from(books)
    .where(inArray(books.code, claimed));
  const idByCode = new Map(known.map((book) => [book.code, book.id]));

  const parsed: ParsedUsfmFile[] = [];
  for (const [index, file] of files.entries()) {
    const bookCode = claimed[index];
    const bookId = idByCode.get(bookCode);
    if (bookId === undefined) return err(ErrorCode.USFM_BOOK_MISMATCH);

    const usj = convertUSFMToUSJ(file.usfm);
    if (!usj.ok) return err(ErrorCode.USFM_INVALID);

    const idNode = usj.data.content.find((node) => node.type === 'book');
    if (idNode && idNode.type === 'book' && idNode.code.toUpperCase() !== bookCode) {
      return err(ErrorCode.USFM_BOOK_MISMATCH);
    }

    const verses = usjToVerseTexts(usj.data);
    if (verses.length === 0) return err(ErrorCode.USFM_INVALID);

    parsed.push({ ...file, bookCode, bookId, verses });
  }

  return ok(parsed);
}

export type MaterializeOutcome = 'materialized' | 'pending';

/**
 * Turns one stored file into editable rows. translated_verses hangs off the source bible's
 * bible_texts, so this can only happen once that book's text has been ingested; before then it
 * reports `pending` and leaves the import untouched for the ingestion worker to finish. Verses
 * the source does not have (versification differences) are skipped and counted, never invented.
 */
export async function materializeUsfmImport(
  row: { id: number; projectUnitId: number; bookId: number; usfm: string },
  bibleId: number,
  executor: DbTransaction | typeof db = db
): Promise<Result<MaterializeOutcome>> {
  const sourceTexts = await executor
    .select({
      id: bible_texts.id,
      chapterNumber: bible_texts.chapterNumber,
      verseNumber: bible_texts.verseNumber,
    })
    .from(bible_texts)
    .where(and(eq(bible_texts.bibleId, bibleId), eq(bible_texts.bookId, row.bookId)));

  if (sourceTexts.length === 0) return ok('pending');

  const usj = convertUSFMToUSJ(row.usfm);
  if (!usj.ok) return err(ErrorCode.USFM_INVALID);

  const idByRef = new Map(sourceTexts.map((t) => [`${t.chapterNumber}:${t.verseNumber}`, t.id]));
  let unmatched = 0;
  const rows = usjToVerseTexts(usj.data).flatMap((verse) => {
    const bibleTextId = idByRef.get(`${verse.chapterNumber}:${verse.verseNumber}`);
    if (bibleTextId === undefined) {
      unmatched += 1;
      return [];
    }
    if (verse.text.length === 0) return [];
    return [{ projectUnitId: row.projectUnitId, bibleTextId, content: verse.text }];
  });

  if (rows.length > 0) {
    // A re-run after a partial failure must not clobber anything a translator has since edited.
    await executor
      .insert(translated_verses)
      .values(rows)
      .onConflictDoNothing({
        target: [translated_verses.projectUnitId, translated_verses.bibleTextId],
      });
  }

  await repo.markUsfmImportMaterialized(row.id, executor);

  if (unmatched > 0) {
    logger.warn('Imported USFM verses with no matching source verse were skipped', {
      projectUnitId: row.projectUnitId,
      bookId: row.bookId,
      unmatched,
    });
  }

  return ok('materialized');
}

/**
 * Finishes any imports for these books whose source text was not there when the project was
 * created. Called from the text-ingestion worker right after it has created the chapter
 * assignments, and from project creation for books that were already ingested.
 */
export async function materializePendingUsfmImports(
  projectUnitId: number,
  bibleId: number,
  bookIds: number[]
): Promise<Result<{ materialized: number; pending: number }>> {
  try {
    const imports = await repo.getPendingUsfmImports(projectUnitId, bookIds);
    let materialized = 0;
    let pending = 0;

    for (const row of imports) {
      const outcome = await materializeUsfmImport(row, bibleId);
      if (!outcome.ok) return outcome;
      if (outcome.data === 'materialized') materialized += 1;
      else pending += 1;
    }

    return ok({ materialized, pending });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to materialise imported USFM',
      context: { projectUnitId, bibleId, bookIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
