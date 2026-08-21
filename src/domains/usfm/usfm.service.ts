import archiver from 'archiver';
import { Readable } from 'node:stream';

import type { Result } from '@/lib/types';

import { logger } from '@/lib/logger';
import { ok } from '@/lib/types';

import type { BookFields, ExportResult, VerseData } from './usfm.types';

import * as repo from './usfm.repository';

const MAX_COMPRESSION_LEVEL = 9;

export function getProjectName(projectUnitId: number) {
  return repo.getProjectName(projectUnitId);
}

export function validateBookIds(projectUnitId: number, bookIds?: number[]) {
  return repo.validateBookIds(projectUnitId, bookIds);
}

export function getAvailableBooksForExport(projectUnitId: number) {
  return repo.getAvailableBooksForExport(projectUnitId);
}

export function createUSFMStreamForBook(verses: VerseData[], book?: BookFields): Readable {
  if (verses.length === 0) {
    return Readable.from([]);
  }

  const { bookCode, bookName } = verses[0];

  async function* generateUSFMChunks() {
    // Header order is grammar-enforced: \id, \h, the \toc block, then \mt. A \toc
    // line after \mt is a parse error for usfm-grammar, not merely unconventional.
    //
    // fluent-web#398: \mt is derived at render time from the short name (\toc2)
    // rather than written on save, so an authored book_title survives a TOC edit
    // instead of being overwritten; it still supplies \mt whenever no short name
    // is set. \h likewise borrows the short name before falling back to the
    // English display name, so a vernacular \toc2 is not paired with an English
    // running header.
    //
    // Trimmed-truthy rather than `??` throughout: rows written by seeds or direct
    // SQL never passed through the schema's trim, and a blank value must not
    // produce an empty marker line.
    const runningHeader = book?.runningHeader?.trim();
    const bookTitle = book?.bookTitle?.trim();
    const tocLongName = book?.tocLongName?.trim();
    const tocShortName = book?.tocShortName?.trim();
    const tocAbbreviation = book?.tocAbbreviation?.trim();

    yield `\\id ${bookCode}\n`;
    yield `\\h ${runningHeader || tocShortName || bookName}\n`;

    // Unlike \h and \mt the \toc fields have no display-name fallback: unset means
    // the line is omitted, not defaulted.
    if (tocLongName) yield `\\toc1 ${tocLongName}\n`;
    if (tocShortName) yield `\\toc2 ${tocShortName}\n`;
    if (tocAbbreviation) yield `\\toc3 ${tocAbbreviation}\n`;

    yield `\\mt ${tocShortName || bookTitle || bookName}\n`;

    let currentChapter: number | null = null;

    for (const verse of verses) {
      const content = verse.translatedContent ?? '';
      // Stored paragraph starts for this verse, defensively bounded: offsets past the
      // content are dropped rather than corrupting the output. Offset 0 (the verse
      // opens a paragraph) is valid even while the verse is still empty.
      const paragraphs = (verse.markers?.paragraphs ?? []).filter(
        (p) => p.offset === 0 || p.offset < content.length
      );
      const opening = paragraphs.find((p) => p.offset === 0);
      const isChapterStart = currentChapter !== verse.chapterNumber;

      if (isChapterStart) {
        currentChapter = verse.chapterNumber;
        yield `\\c ${verse.chapterNumber}\n`;
      }

      // Heading blocks sit before the verse, and before its paragraph marker: a heading is a
      // block of its own, so the verse that follows still needs a paragraph to live in.
      for (const heading of verse.markers?.headings ?? []) {
        yield `\\${heading.marker} ${heading.text}\n`;
      }

      if (opening) {
        yield `\\${opening.marker}\n`;
      } else if (isChapterStart) {
        // Rows predating the markers column carry none, so every chapter still opens with the
        // single default \\p those exports always had.
        yield '\\p\n';
      }

      // A mid-text offset splits the verse across paragraphs: the text continues
      // after the marker without a new \\v, which is exactly how USFM writes it.
      let text = '';
      let cursor = 0;
      for (const paragraph of paragraphs) {
        if (paragraph.offset === 0) continue;
        text += `${content.slice(cursor, paragraph.offset)}\n\\${paragraph.marker}\n`;
        cursor = paragraph.offset;
      }
      text += content.slice(cursor);

      yield `\\v ${verse.verseNumber} ${text}\n`;
    }

    yield '\n';
  }

  return Readable.from(generateUSFMChunks());
}

export async function createUSFMZipStreamAsync(
  projectUnitId: number,
  bookIds?: number[]
): Promise<Result<ExportResult | null>> {
  const booksResult = await repo.getProjectBooks(projectUnitId, bookIds);
  if (!booksResult.ok) return booksResult;

  const projectBooks = booksResult.data;

  if (projectBooks.length === 0) {
    logger.info('No books found for export', { projectUnitId, bookIds });
    return ok(null);
  }

  const archive = archiver('zip', { zlib: { level: MAX_COMPRESSION_LEVEL } });
  let cleanupExecuted = false;
  let hasError = false;

  const cleanup = () => {
    if (cleanupExecuted) {
      return;
    }
    cleanupExecuted = true;

    if (!archive.destroyed) {
      archive.destroy();
    }
    logger.info('Archive cleanup executed', { projectUnitId, bookIds });
  };

  archive.on('error', (error) => {
    hasError = true;
    logger.error('Archive error:', { error, projectUnitId, bookIds });
  });

  archive.on('warning', (error) => {
    if (error.code === 'ENOENT') {
      logger.warn('Archive warning - file not found:', { warning: error, projectUnitId });
    } else {
      hasError = true;
      logger.error('Archive critical warning:', { error, projectUnitId, bookIds });
    }
  });

  archive.on('end', () => {
    logger.info('Archive finalized successfully', { projectUnitId, bookIds });
  });

  const processData = async () => {
    try {
      const bookIdArray = projectBooks.map((b) => b.bookId);
      const versesResult = await repo.getBookVerses(projectUnitId, bookIdArray);
      if (!versesResult.ok) {
        hasError = true;
        if (!archive.destroyed) archive.destroy(new Error('Failed to fetch verses'));
        return;
      }

      const versesByBook = versesResult.data;

      for (const book of projectBooks) {
        if (hasError) {
          logger.warn('Stopping USFM generation due to error', { projectUnitId });
          break;
        }

        const verses = versesByBook.get(book.bookId) ?? [];

        if (verses.length === 0) {
          logger.warn('No verses found for book', {
            projectUnitId,
            bookId: book.bookId,
            bookCode: book.bookCode,
          });
          continue;
        }

        const bookStream = createUSFMStreamForBook(verses, book);
        archive.append(bookStream, { name: `${book.bookCode}.usfm` });

        await new Promise((resolve) => process.nextTick(resolve));
      }

      if (!hasError) {
        await archive.finalize();
      } else {
        archive.destroy();
      }
    } catch (error) {
      hasError = true;
      logger.error('Error processing USFM stream:', { error, projectUnitId, bookIds });
      const errObj =
        error instanceof Error ? error : new Error('Unknown error during USFM generation');
      if (!archive.destroyed) {
        archive.destroy(errObj);
      }
    }
  };

  processData().catch((error) => {
    hasError = true;
    logger.error('Unhandled error in processData:', { error, projectUnitId, bookIds });
  });

  return ok({ stream: archive, cleanup });
}
