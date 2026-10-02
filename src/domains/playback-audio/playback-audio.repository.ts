import { and, asc, eq } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_texts, books } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

/** Local source verse numbers, independent of what the recording timecodes cover. */
export async function getSourceChapterVerseNumbers(
  bibleId: number,
  bookCode: string,
  chapter: number
): Promise<Result<number[]>> {
  try {
    const rows = await db
      .select({ verseNumber: bible_texts.verseNumber })
      .from(bible_texts)
      .innerJoin(books, eq(bible_texts.bookId, books.id))
      .where(
        and(
          eq(bible_texts.bibleId, bibleId),
          eq(books.code, bookCode),
          eq(bible_texts.chapterNumber, chapter)
        )
      )
      .orderBy(asc(bible_texts.verseNumber));
    return ok(rows.map((row) => row.verseNumber));
  } catch (cause) {
    logger.error({
      cause,
      message: 'Failed to read source chapter verses for playback',
      context: { bibleId, bookCode, chapter },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
