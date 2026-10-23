import { and, asc, eq, inArray, ne } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_texts, verse_audio_recordings, verse_audio_takes } from '@/db/schema';
import { runInTransaction } from '@/db/transaction';
import { hasPostgresErrorCode } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { RangeCoverage } from './verse-audio.coverage';
import type {
  VerseAudioConflictStatus,
  VerseAudioCoverageShape,
  VerseAudioGranularity,
  VerseAudioRecord,
} from './verse-audio.types';

import { coverageFromActive, rangesOverlap } from './verse-audio.coverage';
import { mapForeignKeyViolation } from './verse-audio.errors';
import { VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

/** Shared select shape for recording rows joined to bible_texts anchors. */
export const recordSelection = {
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
 *
 * Already-`resolved` units are not re-flagged (same contract as
 * `markConflictPreservingActive`): a prior adjudication is not silently
 * reopened. They still count as contention for flagging a non-resolved self,
 * so a new contender that only overlaps adjudicated rows is surfaced.
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
      let selfResolved = false;
      let sawOverlap = false;

      for (const record of records) {
        if (record.bibleTextId === input.selfBibleTextId) {
          selfId = record.id;
          selfResolved = record.conflictStatus === VERSE_AUDIO_CONFLICT_STATUS.RESOLVED;
          continue;
        }
        if (record.bookId !== input.bookId) {
          continue;
        }
        const otherCoverage = coverageFromActive(record, record.chapterNumber, record.verseNumber);
        if (!rangesOverlap(input.coverage, otherCoverage)) {
          continue;
        }
        sawOverlap = true;
        // Write-protect adjudicated rows; still counted via sawOverlap above.
        if (record.conflictStatus !== VERSE_AUDIO_CONFLICT_STATUS.RESOLVED) {
          toMark.add(record.id);
        }
      }

      if (sawOverlap && selfId !== undefined && !selfResolved) {
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
          .where(
            and(
              inArray(verse_audio_recordings.id, markedIds),
              ne(verse_audio_recordings.conflictStatus, VERSE_AUDIO_CONFLICT_STATUS.RESOLVED)
            )
          );
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
    const result = await runInTransaction(async (tx) => {
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
        // Rolls back the take write via runInTransaction; caller maps to applied:false.
        return err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT);
      }

      const [hydrated] = await tx
        .select(recordSelection)
        .from(verse_audio_recordings)
        .innerJoin(bible_texts, eq(verse_audio_recordings.bibleTextId, bible_texts.id))
        .where(eq(verse_audio_recordings.id, recordingId))
        .limit(1);

      if (!hydrated) {
        // Belt-and-suspenders: unreachable under FK integrity (recording row just
        // updated). Returning err() aborts the txn so we never commit a partial
        // ok:false Result while coverage+recording stay updated.
        return err(ErrorCode.INTERNAL_ERROR);
      }
      return ok({ applied: true, record: hydrated as VerseAudioRecord });
    });

    if (!result.ok && result.error.code === ErrorCode.VERSE_AUDIO_VERSION_CONFLICT) {
      return ok({ applied: false, record: null });
    }
    return result;
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to atomically update take coverage and recording state',
      context: { takeId, recordingId, expectedVersionToken, shape, patch },
    });
    if (hasPostgresErrorCode(error, '23503')) {
      return mapForeignKeyViolation(error);
    }
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
