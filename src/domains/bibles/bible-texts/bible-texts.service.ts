import type { DbTransaction } from '@/lib/types';

import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  BulkChapterRequest,
  BulkChapterTextResponse,
  BulkVerseRow,
} from './bible-texts.types';

import * as repo from './bible-texts.repository';

// ─── Mappers ──────────────────────────────────────────────────────────────────

function toBulkChapterTextResponses(rows: BulkVerseRow[]): BulkChapterTextResponse[] {
  const grouped = new Map<string, BulkChapterTextResponse>();

  for (const row of rows) {
    const key = `${row.bookId}:${row.chapterNumber}`;
    if (!grouped.has(key)) {
      grouped.set(key, { bookId: row.bookId, chapterNumber: row.chapterNumber, verses: [] });
    }
    grouped.get(key)!.verses.push({
      id: row.id,
      chapterNumber: row.chapterNumber,
      verseNumber: row.verseNumber,
      text: row.text,
    });
  }

  return [...grouped.values()];
}

// ─── Service functions ────────────────────────────────────────────────────────

export function getBibleTextsByChapter(bibleId: number, bookId: number, chapterNumber: number) {
  return repo.getByChapter(bibleId, bookId, chapterNumber);
}

export async function getBulkBibleTexts(bibleId: number, body: BulkChapterRequest) {
  if (body.chapters.length === 0) return ok({ syncedAt: new Date().toISOString(), data: [] });
  const updatedAfter = body.updatedAfter ? new Date(body.updatedAfter) : undefined;

  const result = await repo.getByChapters(bibleId, body.chapters, updatedAfter);

  if (!result.ok) {
    if (updatedAfter) return ok({ syncedAt: new Date().toISOString(), data: [] });
    return result;
  }

  return ok({
    syncedAt: new Date().toISOString(),
    data: toBulkChapterTextResponses(result.data),
  });
}

export async function getBibleBookVerseReferences(
  bibleId: number,
  bookId: number,
  tx?: DbTransaction
) {
  try {
    return ok(await repo.getBookVerseReferences(bibleId, bookId, tx));
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get source verse references',
      context: { bibleId, bookId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
