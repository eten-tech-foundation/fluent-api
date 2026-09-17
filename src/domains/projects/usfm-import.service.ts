import { and, eq, inArray } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';
import type { UsjVerseText } from '@/lib/usfm-converter';

import { db } from '@/db';
import {
  bible_books,
  bible_texts,
  books,
  translated_verses,
  verseMarkersSchema,
} from '@/db/schema';
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
    if (!idNode || idNode.type !== 'book' || !idNode.code) {
      return err(ErrorCode.USFM_BOOK_MISSING);
    }
    if (idNode.code.toUpperCase() !== bookCode) {
      return err(ErrorCode.USFM_BOOK_MISMATCH);
    }

    const verses = usjToVerseTexts(usj.data);
    if (!verses.ok || verses.data.length === 0) return err(ErrorCode.USFM_INVALID);

    parsed.push({ ...file, bookCode, bookId, verses: verses.data });
  }

  return ok(parsed);
}

export type MaterializeOutcome = 'materialized' | 'pending';

/**
 * Turns one stored file into editable rows. translated_verses hangs off the source bible's
 * bible_texts, so this can only happen once that book's text has been ingested; before then it
 * reports `pending` and leaves the import untouched for the ingestion worker to finish. Verses
 * the source does not have (versification differences), or that have no imported text, are
 * skipped and counted, never invented.
 */
export async function materializeUsfmImport(
  row: { id: number; projectUnitId: number; bookId: number; usfm: string },
  bibleId: number,
  executor: DbTransaction | typeof db = db,
  parsedVerses?: UsjVerseText[]
): Promise<Result<MaterializeOutcome>> {
  const [sourceBook] = await executor
    .select({ textIngestedAt: bible_books.textIngestedAt })
    .from(bible_books)
    .where(and(eq(bible_books.bibleId, bibleId), eq(bible_books.bookId, row.bookId)));

  if (!sourceBook?.textIngestedAt) return ok('pending');

  const sourceTexts = await executor
    .select({
      id: bible_texts.id,
      chapterNumber: bible_texts.chapterNumber,
      verseNumber: bible_texts.verseNumber,
    })
    .from(bible_texts)
    .where(and(eq(bible_texts.bibleId, bibleId), eq(bible_texts.bookId, row.bookId)));

  if (sourceTexts.length === 0) return ok('pending');

  let verses = parsedVerses;
  if (!verses) {
    const usj = convertUSFMToUSJ(row.usfm);
    if (!usj.ok) return err(ErrorCode.USFM_INVALID);
    const parsed = usjToVerseTexts(usj.data);
    if (!parsed.ok) return parsed;
    verses = parsed.data;
  }

  const validatedVerses: UsjVerseText[] = [];
  for (const verse of verses) {
    if (verse.markers === undefined) {
      validatedVerses.push(verse);
      continue;
    }

    const markers = verseMarkersSchema.safeParse(verse.markers);
    if (!markers.success) return err(ErrorCode.USFM_INVALID);
    validatedVerses.push({
      ...verse,
      ...(markers.data === null ? { markers: undefined } : { markers: markers.data }),
    });
  }

  const idByRef = new Map(sourceTexts.map((t) => [`${t.chapterNumber}:${t.verseNumber}`, t.id]));
  let unmatched = 0;
  let empty = 0;
  const rows = validatedVerses.flatMap((verse) => {
    const bibleTextId = idByRef.get(`${verse.chapterNumber}:${verse.verseNumber}`);
    if (bibleTextId === undefined) {
      unmatched += 1;
      return [];
    }
    if (verse.text.length === 0 && verse.markers === undefined) {
      empty += 1;
      return [];
    }
    return [
      {
        projectUnitId: row.projectUnitId,
        bibleTextId,
        content: verse.text,
        ...(verse.markers === undefined ? {} : { markers: verse.markers }),
      },
    ];
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

  if (unmatched > 0 || empty > 0) {
    logger.warn('Imported USFM verses were skipped', {
      projectUnitId: row.projectUnitId,
      bookId: row.bookId,
      unmatched,
      empty,
    });
  }

  return ok('materialized');
}

interface PendingUsfmImport {
  id: number;
  projectUnitId: number;
  bookId: number;
  usfm: string;
}

/** Each import is independent: attempt them all, then return the first failure if any occurred. */
async function materializeEach(
  imports: PendingUsfmImport[],
  bibleId: number,
  parsedFiles: ParsedUsfmFile[]
): Promise<Result<{ materialized: number; pending: number }>> {
  const versesByBook = new Map(parsedFiles.map((file) => [file.bookId, file.verses]));
  const outcomes = await Promise.all(
    imports.map(async (row) => {
      const context = {
        importId: row.id,
        projectUnitId: row.projectUnitId,
        bibleId,
        bookId: row.bookId,
      };
      try {
        const outcome = await materializeUsfmImport(row, bibleId, db, versesByBook.get(row.bookId));
        if (!outcome.ok) {
          logger.error({
            message: 'Failed to materialise imported USFM book',
            context: { ...context, error: outcome.error },
          });
        }
        return outcome;
      } catch (error) {
        logger.error({
          cause: error,
          message: 'Failed to materialise imported USFM book',
          context,
        });
        return err(ErrorCode.INTERNAL_ERROR);
      }
    })
  );

  let materialized = 0;
  let pending = 0;
  let firstFailure: Result<never> | undefined;

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      firstFailure ??= outcome;
      continue;
    }
    if (outcome.data === 'materialized') materialized += 1;
    else pending += 1;
  }

  return firstFailure ?? ok({ materialized, pending });
}

/**
 * Finishes this project unit's imports for these books, using the verses parsed during
 * validation. Called from project creation for books that were already ingested.
 */
export async function materializePendingUsfmImports(
  projectUnitId: number,
  bibleId: number,
  bookIds: number[],
  parsedFiles: ParsedUsfmFile[] = []
): Promise<Result<{ materialized: number; pending: number }>> {
  try {
    const imports = await repo.getPendingUsfmImports(projectUnitId, bookIds);
    return await materializeEach(imports, bibleId, parsedFiles);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to materialise imported USFM',
      context: { projectUnitId, bibleId, bookIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Finishes every import waiting on these books of this Bible, whichever project it belongs to.
 * Called from the text-ingestion worker once a book is complete: completion is a property of the
 * source text, not of the project whose job happened to fetch it, so a project whose own job was
 * never queued or has since given up is finished here rather than left pending forever.
 */
export async function materializePendingUsfmImportsForBible(
  bibleId: number,
  bookIds: number[]
): Promise<Result<{ materialized: number; pending: number }>> {
  try {
    const imports = await repo.getPendingUsfmImportsForBible(bibleId, bookIds);
    return await materializeEach(imports, bibleId, []);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to materialise imported USFM',
      context: { bibleId, bookIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
