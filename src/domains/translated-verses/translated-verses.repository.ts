import { and, eq, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_texts, translated_verses } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  CreateTranslatedVerseInput,
  TranslatedVerseRecord,
  TranslatedVersesFilters,
  UpdateTranslatedVerseInput,
} from './translated-verses.types';

export async function getById(id: number): Promise<Result<TranslatedVerseRecord>> {
  try {
    const [verse] = await db
      .select({
        id: translated_verses.id,
        projectUnitId: translated_verses.projectUnitId,
        content: translated_verses.content,
        bibleTextId: translated_verses.bibleTextId,
        assignedUserId: translated_verses.assignedUserId,
        createdAt: translated_verses.createdAt,
        updatedAt: translated_verses.updatedAt,
        verseNumber: bible_texts.verseNumber,
      })
      .from(translated_verses)
      .innerJoin(bible_texts, eq(translated_verses.bibleTextId, bible_texts.id))
      .where(eq(translated_verses.id, id))
      .limit(1);

    if (!verse) {
      return err(ErrorCode.TRANSLATED_VERSE_NOT_FOUND);
    }

    return ok(verse);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get translated verse by ID',
      context: { id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function create(
  input: CreateTranslatedVerseInput
): Promise<Result<TranslatedVerseRecord>> {
  try {
    const [verse] = await db.insert(translated_verses).values(input).returning();

    const result = await getById(verse.id);
    if (!result.ok) {
      return err(ErrorCode.INTERNAL_ERROR);
    }

    return ok(result.data);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to create translated verse',
      context: { input },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function update(
  id: number,
  input: UpdateTranslatedVerseInput
): Promise<Result<TranslatedVerseRecord>> {
  try {
    const [updated] = await db
      .update(translated_verses)
      .set(input)
      .where(eq(translated_verses.id, id))
      .returning();

    if (!updated) {
      return err(ErrorCode.TRANSLATED_VERSE_NOT_FOUND);
    }

    const result = await getById(updated.id);
    if (!result.ok) {
      return err(ErrorCode.INTERNAL_ERROR);
    }

    return ok(result.data);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to update translated verse',
      context: { id, input },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function upsert(
  input: CreateTranslatedVerseInput
): Promise<Result<TranslatedVerseRecord>> {
  try {
    const [verse] = await db
      .insert(translated_verses)
      .values(input)
      .onConflictDoUpdate({
        target: [translated_verses.projectUnitId, translated_verses.bibleTextId],
        set: {
          content: sql`excluded.content`,
          assignedUserId: sql`excluded.assigned_user_id`,
        },
      })
      .returning();

    const result = await getById(verse.id);
    if (!result.ok) {
      return err(ErrorCode.INTERNAL_ERROR);
    }

    return ok(result.data);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to upsert translated verse',
      context: { input },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function list(
  filters: TranslatedVersesFilters = {}
): Promise<Result<TranslatedVerseRecord[]>> {
  try {
    const conditions = [] as any[];
    if (filters.projectUnitId !== undefined) {
      conditions.push(eq(translated_verses.projectUnitId, filters.projectUnitId));
    }
    if (filters.bookId !== undefined) {
      conditions.push(eq(bible_texts.bookId, filters.bookId));
    }
    if (filters.chapterNumber !== undefined) {
      conditions.push(eq(bible_texts.chapterNumber, filters.chapterNumber));
    }
    const baseQuery = db
      .select({
        id: translated_verses.id,
        projectUnitId: translated_verses.projectUnitId,
        content: translated_verses.content,
        bibleTextId: translated_verses.bibleTextId,
        assignedUserId: translated_verses.assignedUserId,
        createdAt: translated_verses.createdAt,
        updatedAt: translated_verses.updatedAt,
        verseNumber: bible_texts.verseNumber,
      })
      .from(translated_verses)
      .innerJoin(bible_texts, eq(translated_verses.bibleTextId, bible_texts.id));
    const verses =
      conditions.length > 0
        ? await baseQuery
            .where(and(...conditions))
            .orderBy(bible_texts.bookId, bible_texts.chapterNumber, bible_texts.verseNumber)
        : await baseQuery.orderBy(
            bible_texts.bookId,
            bible_texts.chapterNumber,
            bible_texts.verseNumber
          );
    return ok(verses);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to list translated verses',
      context: { filters },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
