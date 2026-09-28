import type { DbTransaction, Result } from '@/lib/types';
import type { UsjVerseText } from '@/lib/usfm-converter';

import { verseMarkersSchema } from '@/db/schema';
import * as bibleBooksService from '@/domains/bible-books/bible-books.service';
import * as bibleTextsService from '@/domains/bibles/bible-texts/bible-texts.service';
import * as booksService from '@/domains/books/books.service';
import * as translatedVersesService from '@/domains/translated-verses/translated-verses.service';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';
import { convertUSFMToUSJ, usjToVerseTexts } from '@/lib/usfm-converter';

import type { ParsedUsfmFile, UsfmFileInput } from './projects.types';

import * as repo from './projects.repository';

/** Match the upload screen: first valid id, toc3, then mt/mt1 code token. */
function detectBookCode(usfm: string, knownCodes: Set<string>): string | undefined {
  const markers = [...usfm.matchAll(/\\([a-z]+\d*)[ \t]*([^\\\r\n]*)/gi)];
  for (const names of [['id'], ['toc3'], ['mt', 'mt1']]) {
    const marker = markers.find((match) => names.includes(match[1].toLowerCase()));
    const code = marker?.[2].trim().split(/\s+/)[0].toUpperCase();
    if (code && knownCodes.has(code)) return code;
  }
}

/** Supply the grammar's required id on a parsing copy; the stored file is never changed. */
function withParserBookId(usfm: string, bookCode: string): string {
  const id = /\\id(?=[\s\\]|$)[^\\\r\n]*/i;
  if (id.test(usfm)) return usfm.replace(id, `\\id ${bookCode}`);
  return `\\id ${bookCode}\n${usfm}`;
}

function validateVerseMarkers(verses: UsjVerseText[]): Result<UsjVerseText[]> {
  const validated: UsjVerseText[] = [];
  for (const verse of verses) {
    if (verse.markers === undefined) {
      validated.push(verse);
      continue;
    }
    const markers = verseMarkersSchema.safeParse(verse.markers);
    if (!markers.success) return err(ErrorCode.USFM_INVALID);
    validated.push({ ...verse, markers: markers.data ?? undefined });
  }
  return ok(validated);
}

function parseImportVerses(usfm: string, bookCode: string): Result<UsjVerseText[]> {
  const usj = convertUSFMToUSJ(withParserBookId(usfm, bookCode));
  if (!usj.ok) return err(ErrorCode.USFM_INVALID);
  const verses = usjToVerseTexts(usj.data);
  if (!verses.ok || verses.data.length === 0) return err(ErrorCode.USFM_INVALID);
  return validateVerseMarkers(verses.data);
}

/**
 * Re-validates every file server-side before anything is written, so one bad file rejects the
 * whole import (#418's rule, not trusted from the client). The book each file claims must be a
 * real book and must match the code detected from `\id`, `\toc3` or `\mt`; the ids that come back are what
 * the project is created with, since the files are the authority on which books exist.
 */
export async function parseUsfmFiles(files: UsfmFileInput[]): Promise<Result<ParsedUsfmFile[]>> {
  const claimed = files.map((file) => file.bookCode.trim().toUpperCase());
  if (new Set(claimed).size !== claimed.length) {
    return err(ErrorCode.USFM_BOOK_MISMATCH);
  }

  const known = await booksService.getAllBooks();
  if (!known.ok) return known;
  const idByCode = new Map(known.data.map((book) => [book.code, book.id]));
  const knownCodes = new Set(idByCode.keys());

  const parsed: ParsedUsfmFile[] = [];
  for (const [index, file] of files.entries()) {
    const bookCode = claimed[index];
    const bookId = idByCode.get(bookCode);
    if (bookId === undefined) return err(ErrorCode.USFM_BOOK_MISMATCH);

    const detectedCode = detectBookCode(file.usfm, knownCodes);
    if (!detectedCode) {
      return err(/\\[a-z]/i.test(file.usfm) ? ErrorCode.USFM_BOOK_MISSING : ErrorCode.USFM_INVALID);
    }
    if (detectedCode !== bookCode) return err(ErrorCode.USFM_BOOK_MISMATCH);

    const verses = parseImportVerses(file.usfm, bookCode);
    if (!verses.ok) return verses;

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
  tx?: DbTransaction,
  parsedVerses?: UsjVerseText[]
): Promise<Result<MaterializeOutcome>> {
  const sourceBook = await bibleBooksService.isBibleBookTextIngested(bibleId, row.bookId, tx);
  if (!sourceBook.ok) return sourceBook;
  if (!sourceBook.data) return ok('pending');

  const sourceTexts = await bibleTextsService.getBibleBookVerseReferences(bibleId, row.bookId, tx);
  if (!sourceTexts.ok) return sourceTexts;
  if (sourceTexts.data.length === 0) return ok('pending');

  let verses = parsedVerses;
  if (!verses) {
    const book = await booksService.getBookById(row.bookId);
    if (!book.ok) return book;
    const parsed = parseImportVerses(row.usfm, book.data.code);
    if (!parsed.ok) return parsed;
    verses = parsed.data;
  }
  const validated = validateVerseMarkers(verses);
  if (!validated.ok) return validated;

  const idByRef = new Map(
    sourceTexts.data.map((t) => [`${t.chapterNumber}:${t.verseNumber}`, t.id])
  );
  let unmatched = 0;
  let empty = 0;
  const rows = validated.data.flatMap((verse) => {
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
    const imported = await translatedVersesService.importTranslatedVerses(rows, tx);
    if (!imported.ok) return imported;
  }
  await repo.markUsfmImportMaterialized(row.id, tx);

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
        const outcome = await materializeUsfmImport(
          row,
          bibleId,
          undefined,
          versesByBook.get(row.bookId)
        );
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
