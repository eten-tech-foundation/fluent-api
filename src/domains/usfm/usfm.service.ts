import archiver from 'archiver';
import { Readable } from 'node:stream';

import type { Result } from '@/lib/types';

import { logger } from '@/lib/logger';
import { ok } from '@/lib/types';

import type { ExportResult, VerseData } from './usfm.types';

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

export function createUSFMStreamForBook(verses: VerseData[]): Readable {
  if (verses.length === 0) {
    return Readable.from([]);
  }

  const { bookCode, bookName } = verses[0];

  async function* generateUSFMChunks() {
    yield `\\id ${bookCode}\n`;
    yield `\\h ${bookName}\n`;
    yield `\\mt ${bookName}\n`;

    let currentChapter: number | null = null;

    for (const verse of verses) {
      if (currentChapter !== verse.chapterNumber) {
        yield `\\c ${verse.chapterNumber}\n\\p\n`;
        currentChapter = verse.chapterNumber;
      }
      yield `\\v ${verse.verseNumber} ${verse.translatedContent ?? ''}\n`;
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

        const bookStream = createUSFMStreamForBook(verses);
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
