import { and, eq, or } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_texts } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { BibleTextResponse, BulkVerseRow } from './bible-texts.types';

export async function getByChapter(
  bibleId: number,
  bookId: number,
  chapterNumber: number
): Promise<Result<BibleTextResponse[]>> {
  try {
    const texts = await db
      .select({
        id: bible_texts.id,
        chapterNumber: bible_texts.chapterNumber,
        verseNumber: bible_texts.verseNumber,
        text: bible_texts.text,
      })
      .from(bible_texts)
      .where(
        and(
          eq(bible_texts.bibleId, bibleId),
          eq(bible_texts.bookId, bookId),
          eq(bible_texts.chapterNumber, chapterNumber)
        )
      )
      .orderBy(bible_texts.verseNumber);

    if (texts.length === 0) return err(ErrorCode.NOT_FOUND);
    return ok(texts);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get bible text by chapter',
      context: { bibleId, bookId, chapterNumber },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

// ─── Bulk chapter fetch ───────────────────────────────────────────────────────────────

interface ChapterKey {
  bookId: number;
  chapterNumber: number;
}

export async function getByChapters(
  bibleId: number,
  chapters: ChapterKey[]
): Promise<Result<BulkVerseRow[]>> {
  try {
    const conditions = chapters.map((ch) =>
      and(eq(bible_texts.bookId, ch.bookId), eq(bible_texts.chapterNumber, ch.chapterNumber))
    );

    const rows = await db
      .select({
        id: bible_texts.id,
        bookId: bible_texts.bookId,
        chapterNumber: bible_texts.chapterNumber,
        verseNumber: bible_texts.verseNumber,
        text: bible_texts.text,
      })
      .from(bible_texts)
      .where(and(eq(bible_texts.bibleId, bibleId), or(...conditions)))
      .orderBy(bible_texts.bookId, bible_texts.chapterNumber, bible_texts.verseNumber);

    if (rows.length === 0) return err(ErrorCode.NOT_FOUND);

    return ok(rows);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get bible texts by multiple chapters',
      context: { bibleId, chaptersCount: chapters.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
