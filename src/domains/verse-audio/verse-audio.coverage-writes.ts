import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_texts, verse_audio_recordings, verse_audio_takes } from '@/db/schema';
import { hasPostgresErrorCode } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { RangeCoverage } from './verse-audio.coverage';
import type {
  VerseAudioConflictStatus,
  VerseAudioCoverageShape,
  VerseAudioGranularity,
  VerseAudioRecord,
  VerseAudioTakeRecord,
} from './verse-audio.types';

import * as takesRepo from './verse-audio-takes.repository';
import { coverageFromActive, rangesOverlap } from './verse-audio.coverage';
import { VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

const recordSelection = {
  id: verse_audio_recordings.id,
  projectUnitId: verse_audio_recordings.projectUnitId,
  bibleTextId: verse_audio_recordings.bibleTextId,
  uploadedBy: verse_audio_recordings.uploadedBy,
  storageObjectId: verse_audio_recordings.storageObjectId,
  contentType: verse_audio_recordings.contentType,
  sizeBytes: verse_audio_recordings.sizeBytes,
  durationSeconds: verse_audio_recordings.durationSeconds,
  versionToken: verse_audio_recordings.versionToken,
  conflictStatus: verse_audio_recordings.conflictStatus,
  granularity: verse_audio_recordings.granularity,
  startChapter: verse_audio_recordings.startChapter,
  startVerse: verse_audio_recordings.startVerse,
  endChapter: verse_audio_recordings.endChapter,
  endVerse: verse_audio_recordings.endVerse,
  activeTakeId: verse_audio_recordings.activeTakeId,
  createdAt: verse_audio_recordings.createdAt,
  updatedAt: verse_audio_recordings.updatedAt,
  bookId: bible_texts.bookId,
  chapterNumber: bible_texts.chapterNumber,
  verseNumber: bible_texts.verseNumber,
};

export interface RecordingStatePatch {
  uploadedBy?: number;
  /** Pass `null` to clear; omit (`undefined`) to leave unchanged. */
  storageObjectId?: number | null;
  contentType?: string;
  sizeBytes?: number;
  durationSeconds?: number | null;
  versionToken?: number;
  conflictStatus?: VerseAudioConflictStatus;
  activeTakeId?: number | null;
  granularity?: VerseAudioGranularity;
  startChapter?: number | null;
  startVerse?: number | null;
  endChapter?: number | null;
  endVerse?: number | null;
}

/**
 * Lock every recording in the project unit (`FOR UPDATE`), then mark self +
 * same-book intersecting active coverages as `conflict` without bumping
 * `versionToken`. Used after uploads that introduce a new contender or change
 * active coverage — not for idempotent same-shape retries.
 */
export async function markIntersectingCoverageConflicts(input: {
  projectUnitId: number;
  selfBibleTextId: number;
  bookId: number;
  coverage: RangeCoverage;
}): Promise<Result<{ markedIds: number[] }>> {
  try {
    return await db.transaction(async (tx) => {
      const locked = await tx
        .select(recordSelection)
        .from(verse_audio_recordings)
        .innerJoin(bible_texts, eq(verse_audio_recordings.bibleTextId, bible_texts.id))
        .where(eq(verse_audio_recordings.projectUnitId, input.projectUnitId))
        .orderBy(asc(verse_audio_recordings.id))
        .for('update');

      const records = locked as VerseAudioRecord[];
      const toMark = new Set<number>();
      let selfId: number | undefined;

      for (const record of records) {
        if (record.bibleTextId === input.selfBibleTextId) {
          selfId = record.id;
          continue;
        }
        if (record.bookId !== input.bookId) {
          continue;
        }
        const otherCoverage = coverageFromActive(record, record.chapterNumber, record.verseNumber);
        if (rangesOverlap(input.coverage, otherCoverage)) {
          toMark.add(record.id);
        }
      }

      if (toMark.size > 0 && selfId !== undefined) {
        toMark.add(selfId);
      }

      const markedIds = [...toMark].sort((a, b) => a - b);
      if (markedIds.length > 0) {
        await tx
          .update(verse_audio_recordings)
          .set({
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
            updatedAt: new Date(),
          })
          .where(inArray(verse_audio_recordings.id, markedIds));
      }

      return ok({ markedIds });
    });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to mark intersecting verse-audio coverage conflicts',
      context: {
        projectUnitId: input.projectUnitId,
        selfBibleTextId: input.selfBibleTextId,
        bookId: input.bookId,
      },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/** Updates take coverage metadata in place (same contentHash, new range shape). */
export async function updateTakeCoverage(
  takeId: number,
  shape: VerseAudioCoverageShape
): Promise<Result<VerseAudioTakeRecord>> {
  try {
    const [row] = await db
      .update(verse_audio_takes)
      .set({
        granularity: shape.granularity,
        startChapter: shape.startChapter,
        startVerse: shape.startVerse,
        endChapter: shape.endChapter,
        endVerse: shape.endVerse,
        updatedAt: new Date(),
      })
      .where(eq(verse_audio_takes.id, takeId))
      .returning();

    if (!row) {
      return err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND);
    }
    return ok(row);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to update verse audio take coverage',
      context: { takeId, shape },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Atomically update take coverage and CAS-promote the recording. If the
 * version predicate misses, the take write is rolled back with the transaction
 * so coverage cannot diverge from the recording row.
 */
export async function updateTakeCoverageAndRecordingIfVersion(
  takeId: number,
  recordingId: number,
  expectedVersionToken: number,
  shape: VerseAudioCoverageShape,
  patch: RecordingStatePatch
): Promise<Result<{ applied: boolean; record: VerseAudioRecord | null }>> {
  try {
    return await db.transaction(async (tx) => {
      const [takeRow] = await tx
        .update(verse_audio_takes)
        .set({
          granularity: shape.granularity,
          startChapter: shape.startChapter,
          startVerse: shape.startVerse,
          endChapter: shape.endChapter,
          endVerse: shape.endVerse,
          updatedAt: new Date(),
        })
        .where(eq(verse_audio_takes.id, takeId))
        .returning({ id: verse_audio_takes.id });

      if (!takeRow) {
        return err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND);
      }

      const [row] = await tx
        .update(verse_audio_recordings)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(verse_audio_recordings.id, recordingId),
            eq(verse_audio_recordings.versionToken, expectedVersionToken)
          )
        )
        .returning();

      if (!row) {
        // Must throw: returning a Result from the callback still commits the txn.
        throw new Error('VERSE_AUDIO_CAS_MISS');
      }

      const [hydrated] = await tx
        .select(recordSelection)
        .from(verse_audio_recordings)
        .innerJoin(bible_texts, eq(verse_audio_recordings.bibleTextId, bible_texts.id))
        .where(eq(verse_audio_recordings.id, recordingId))
        .limit(1);

      if (!hydrated) {
        // Both writes already ran — throw so Drizzle aborts rather than committing
        // an ok:false Result while coverage+recording stay updated.
        throw new Error('VERSE_AUDIO_HYDRATION_MISS');
      }
      return ok({ applied: true, record: hydrated as VerseAudioRecord });
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'VERSE_AUDIO_CAS_MISS') {
      return ok({ applied: false, record: null });
    }
    logger.error({
      cause: error,
      message: 'Failed to atomically update take coverage and recording state',
      context: { takeId, recordingId, expectedVersionToken, shape, patch },
    });
    if (hasPostgresErrorCode(error, '23503')) {
      return takesRepo.mapForeignKeyViolation(error);
    }
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
