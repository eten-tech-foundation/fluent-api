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

import type {
  ParsedUsfmFile,
  UsfmFileCheck,
  UsfmFileInput,
  UsfmFileProblem,
  UsfmFileToCheck,
} from './projects.types';

import * as repo from './projects.repository';
import { bookCodeFromName } from './usfm-book-names';

/** Completed-source imports whose durable intent still needs an editable projection. */
export function getUsfmImportsReadyForMaterialization() {
  return repo.getUsfmImportsReadyForMaterialization();
}

/**
 * The book a file is for: the code in `\id`, else the book its `\toc3` or a `\mt` line names
 * (#418). The upload check and project creation both go through here, so they cannot disagree.
 */
function detectBookCode(usfm: string, knownCodes: ReadonlySet<string>): string | undefined {
  let id: string | undefined;
  let toc3: string | undefined;
  const titles: string[] = [];
  for (const [, name, text] of usfm.matchAll(/\\([a-z]+\d*)[ \t]*([^\\\r\n]*)/gi)) {
    const marker = name.toLowerCase();
    if (marker === 'id') id ??= text;
    else if (marker === 'toc3') toc3 ??= text;
    else if (/^mt\d*$/.test(marker)) titles.push(text);
  }

  const idCode = id?.trim().split(/\s+/)[0].toUpperCase();
  if (idCode && knownCodes.has(idCode)) return idCode;
  for (const name of [toc3, ...titles]) {
    const code = name === undefined ? undefined : bookCodeFromName(name, knownCodes);
    if (code) return code;
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

/** The project an Add Milestone import goes into (#418, #419). */
interface UsfmImportTarget {
  projectId: number;
  sourceBibleId: number;
}

/** Every file's verdict, plus the parsed files when all of them passed. */
interface PreparedUsfmImport {
  verdicts: UsfmFileCheck[];
  accepted: ParsedUsfmFile[];
}

interface ImportFacts {
  books: Map<string, { id: number; name: string }>;
  sourceBibleName: string;
  sourceBookIds: Set<number>;
  // The milestone that holds each book; null when the book was removed from its milestone.
  placements: Map<number, string | null>;
}

async function loadImportFacts(
  target: UsfmImportTarget,
  tx?: DbTransaction
): Promise<Result<ImportFacts>> {
  const [known, sourceBooks, placements] = await Promise.all([
    booksService.getAllBooks(),
    bibleBooksService.getBibleBooksByBibleId(target.sourceBibleId),
    repo.getProjectBookPlacements(target.projectId, tx),
  ]);
  if (!known.ok) return known;
  if (!sourceBooks.ok) return sourceBooks;

  const placed = new Map<number, string | null>();
  for (const row of placements) {
    // A book in an active milestone is reported there, even if a removed row also exists.
    if (row.deletedAt === null) placed.set(row.bookId, row.milestoneName);
    else if (!placed.has(row.bookId)) placed.set(row.bookId, null);
  }

  return ok({
    books: new Map(
      known.data.map((book) => [book.code, { id: book.id, name: book.eng_display_name }])
    ),
    // Every row names the Bible; a Bible with no books has no name to give, and accepts nothing.
    sourceBibleName: sourceBooks.data[0]?.bible.name ?? 'the Source Bible',
    sourceBookIds: new Set(sourceBooks.data.map((row) => row.bookId)),
    placements: placed,
  });
}

function rejected(
  fileName: string,
  error: UsfmFileProblem,
  book?: { code: string; name: string },
  extra: { milestoneName?: string | null; sourceBibleName?: string } = {}
): UsfmFileCheck {
  const messages: Record<UsfmFileProblem, string> = {
    USFM_INVALID: 'File is not a valid USFM file.',
    USFM_BOOK_MISSING: 'Missing book data.',
    USFM_BOOK_DUPLICATE: `${book?.name} was already added.`,
    USFM_BOOK_EXISTS: extra.milestoneName
      ? `${book?.name} already exists in ${extra.milestoneName}.`
      : `${book?.name} already exists in this project.`,
    USFM_BOOK_NOT_IN_SOURCE: `${book?.name} is not in ${extra.sourceBibleName}.`,
  };
  return {
    fileName,
    ok: false,
    error,
    message: messages[error],
    ...(book && { bookCode: book.code, bookName: book.name }),
    ...extra,
  };
}

/**
 * Checks files for an Add Milestone import (#418, #419) with the same detection and parse the
 * import runs, and writes nothing. Each file gets its own verdict. A file is refused when it is
 * not USFM, names no book, repeats a book already in the upload (`listedBookCodes` holds the
 * books the dialog has accepted so far), holds a book the project already has in any milestone,
 * removed ones included (an import never merges into existing content), or holds a book the
 * project's Source Bible lacks.
 */
export async function prepareUsfmImport(
  target: UsfmImportTarget,
  files: UsfmFileToCheck[],
  listedBookCodes: string[] = [],
  tx?: DbTransaction
): Promise<Result<PreparedUsfmImport>> {
  const facts = await loadImportFacts(target, tx);
  if (!facts.ok) return facts;
  const { books, placements, sourceBibleName, sourceBookIds } = facts.data;
  const knownCodes = new Set(books.keys());
  const listed = new Set(listedBookCodes.map((code) => code.trim().toUpperCase()));

  const verdicts: UsfmFileCheck[] = [];
  const accepted: ParsedUsfmFile[] = [];
  for (const { fileName, usfm } of files) {
    const bookCode = detectBookCode(usfm, knownCodes);
    if (!bookCode) {
      verdicts.push(
        rejected(fileName, /\\[a-z]/i.test(usfm) ? 'USFM_BOOK_MISSING' : 'USFM_INVALID')
      );
      continue;
    }
    const verses = parseImportVerses(usfm, bookCode);
    if (!verses.ok) {
      verdicts.push(rejected(fileName, 'USFM_INVALID'));
      continue;
    }

    // detectBookCode only returns codes from `books`, so the lookup always finds one.
    const { id: bookId, name: bookName } = books.get(bookCode) ?? { id: 0, name: bookCode };
    const book = { code: bookCode, name: bookName };
    if (listed.has(bookCode)) {
      verdicts.push(rejected(fileName, 'USFM_BOOK_DUPLICATE', book));
    } else if (placements.has(bookId)) {
      verdicts.push(
        rejected(fileName, 'USFM_BOOK_EXISTS', book, { milestoneName: placements.get(bookId) })
      );
    } else if (!sourceBookIds.has(bookId)) {
      verdicts.push(rejected(fileName, 'USFM_BOOK_NOT_IN_SOURCE', book, { sourceBibleName }));
    } else {
      listed.add(bookCode);
      verdicts.push({ fileName, ok: true, bookCode, bookName });
      accepted.push({ fileName, usfm, bookCode, bookId, verses: verses.data });
    }
  }

  return ok({ verdicts, accepted });
}

/** The project's books, for re-checking an import inside the project lock. */
export async function getBooksInProject(projectId: number, tx: DbTransaction) {
  const rows = await repo.getProjectBookPlacements(projectId, tx);
  return new Set(rows.map((row) => row.bookId));
}

/** Stores each imported file verbatim, the passthrough record of every tag (#419). */
export async function recordUsfmImports(
  projectUnitId: number,
  files: ParsedUsfmFile[],
  tx: DbTransaction
) {
  await repo.insertUsfmImports(
    files.map(({ bookId, fileName, usfm }) => ({ projectUnitId, bookId, fileName, usfm })),
    tx
  );
}

export type MaterializeOutcome = 'materialized' | 'pending';

/**
 * Turns one stored file into editable rows. translated_verses hangs off the source bible's
 * bible_texts, so this can only happen once that book's text has been ingested; before then it
 * reports `pending` and leaves the import untouched for the ingestion worker to finish. Verses
 * the source does not have (versification differences) are skipped and counted, never invented.
 * A verse with no imported text is skipped and counted too, unless it carries markers (a heading,
 * or a paragraph its number opens): that one is stored as a row with empty content, so export
 * can rebuild the structure. Queries that ask whether a verse is translated check for words.
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
