import { and, count, eq } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_texts, books } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

/** Local source chapter size, independent of what the recording timecodes cover. */
export async function getSourceChapterVerseCount(
  bibleId: number,
  bookCode: string,
  chapter: number
): Promise<Result<number>> {
  try {
    const [row] = await db
      .select({ verseCount: count() })
      .from(bible_texts)
      .innerJoin(books, eq(bible_texts.bookId, books.id))
      .where(
        and(
          eq(bible_texts.bibleId, bibleId),
          eq(books.code, bookCode),
          eq(bible_texts.chapterNumber, chapter)
        )
      );
    return ok(row?.verseCount ?? 0);
  } catch (cause) {
    logger.error({
      cause,
      message: 'Failed to count source chapter verses for playback',
      context: { bibleId, bookCode, chapter },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
