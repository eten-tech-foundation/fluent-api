import { and, asc, eq, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_texts, verse_audio_recordings } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { UpsertVerseAudioInput, VerseAudioRecord } from './verse-audio.types';

const recordSelection = {
  id: verse_audio_recordings.id,
  projectUnitId: verse_audio_recordings.projectUnitId,
  bibleTextId: verse_audio_recordings.bibleTextId,
  uploadedBy: verse_audio_recordings.uploadedBy,
  contentType: verse_audio_recordings.contentType,
  sizeBytes: verse_audio_recordings.sizeBytes,
  durationSeconds: verse_audio_recordings.durationSeconds,
  createdAt: verse_audio_recordings.createdAt,
  updatedAt: verse_audio_recordings.updatedAt,
  verseNumber: bible_texts.verseNumber,
};

export async function get(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<VerseAudioRecord>> {
  try {
    const [recording] = await db
      .select(recordSelection)
      .from(verse_audio_recordings)
      .innerJoin(bible_texts, eq(verse_audio_recordings.bibleTextId, bible_texts.id))
      .where(
        and(
          eq(verse_audio_recordings.projectUnitId, projectUnitId),
          eq(verse_audio_recordings.bibleTextId, bibleTextId)
        )
      )
      .limit(1);

    if (!recording) {
      return err(ErrorCode.VERSE_AUDIO_NOT_FOUND);
    }

    return ok(recording);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get verse audio recording',
      context: { projectUnitId, bibleTextId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function listByChapter(
  projectUnitId: number,
  bookId: number,
  chapterNumber: number
): Promise<Result<VerseAudioRecord[]>> {
  try {
    const recordings = await db
      .select(recordSelection)
      .from(verse_audio_recordings)
      .innerJoin(bible_texts, eq(verse_audio_recordings.bibleTextId, bible_texts.id))
      .where(
        and(
          eq(verse_audio_recordings.projectUnitId, projectUnitId),
          eq(bible_texts.bookId, bookId),
          eq(bible_texts.chapterNumber, chapterNumber)
        )
      )
      .orderBy(asc(bible_texts.verseNumber));

    return ok(recordings);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to list verse audio recordings',
      context: { projectUnitId, bookId, chapterNumber },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function upsert(input: UpsertVerseAudioInput): Promise<Result<VerseAudioRecord>> {
  try {
    const [row] = await db
      .insert(verse_audio_recordings)
      .values(input)
      .onConflictDoUpdate({
        target: [verse_audio_recordings.projectUnitId, verse_audio_recordings.bibleTextId],
        set: {
          uploadedBy: sql`excluded.uploaded_by`,
          contentType: sql`excluded.content_type`,
          sizeBytes: sql`excluded.size_bytes`,
          durationSeconds: sql`excluded.duration_seconds`,
          updatedAt: new Date(),
        },
      })
      .returning();

    const result = await get(row.projectUnitId, row.bibleTextId);
    if (!result.ok) {
      return err(ErrorCode.INTERNAL_ERROR);
    }

    return ok(result.data);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to upsert verse audio recording',
      context: { input: { ...input, sizeBytes: input.sizeBytes } },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function remove(projectUnitId: number, bibleTextId: number): Promise<Result<void>> {
  try {
    const deleted = await db
      .delete(verse_audio_recordings)
      .where(
        and(
          eq(verse_audio_recordings.projectUnitId, projectUnitId),
          eq(verse_audio_recordings.bibleTextId, bibleTextId)
        )
      )
      .returning({ id: verse_audio_recordings.id });

    if (deleted.length === 0) {
      return err(ErrorCode.VERSE_AUDIO_NOT_FOUND);
    }

    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to delete verse audio recording',
      context: { projectUnitId, bibleTextId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
