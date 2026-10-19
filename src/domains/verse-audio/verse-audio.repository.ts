import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_texts, verse_audio_recordings, verse_audio_takes } from '@/db/schema';
import { hasPostgresErrorCode } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { RangeCoverage } from './verse-audio.coverage';
import type {
  InsertTakeInput,
  UpsertVerseAudioInput,
  VerseAudioConflictStatus,
  VerseAudioCoverageShape,
  VerseAudioGranularity,
  VerseAudioRecord,
  VerseAudioTakeRecord,
} from './verse-audio.types';

import { mapForeignKeyViolation, takeSelection } from './verse-audio-takes.repository';
import { coverageFromActive, rangesOverlap } from './verse-audio.coverage';
import { VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

export {
  findTakeByContentHash,
  getTakeById,
  insertTake,
  listTakesByRecordingIds,
  listTakesForRecording,
  pruneSupersededTakes,
  takeSelection,
} from './verse-audio-takes.repository';

export interface BibleTextAnchor {
  id: number;
  bookId: number;
  chapterNumber: number;
  verseNumber: number;
}

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

    return ok(recording as VerseAudioRecord);
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
  bibleId: number,
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
          eq(bible_texts.bibleId, bibleId),
          eq(bible_texts.bookId, bookId),
          eq(bible_texts.chapterNumber, chapterNumber)
        )
      )
      .orderBy(asc(bible_texts.verseNumber));

    return ok(recordings as VerseAudioRecord[]);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to list verse audio recordings',
      context: { projectUnitId, bibleId, bookId, chapterNumber },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/** All recordings for a project unit with bible_texts location (overlap scan). */
export async function listByProjectUnit(
  projectUnitId: number
): Promise<Result<VerseAudioRecord[]>> {
  try {
    const recordings = await db
      .select(recordSelection)
      .from(verse_audio_recordings)
      .innerJoin(bible_texts, eq(verse_audio_recordings.bibleTextId, bible_texts.id))
      .where(eq(verse_audio_recordings.projectUnitId, projectUnitId))
      .orderBy(
        asc(bible_texts.bookId),
        asc(bible_texts.chapterNumber),
        asc(bible_texts.verseNumber)
      );

    return ok(recordings as VerseAudioRecord[]);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to list verse audio recordings for project unit',
      context: { projectUnitId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/** Loads book/chapter/verse for range-upload anchor validation. */
export async function getBibleTextById(bibleTextId: number): Promise<Result<BibleTextAnchor>> {
  try {
    const [row] = await db
      .select({
        id: bible_texts.id,
        bookId: bible_texts.bookId,
        chapterNumber: bible_texts.chapterNumber,
        verseNumber: bible_texts.verseNumber,
      })
      .from(bible_texts)
      .where(eq(bible_texts.id, bibleTextId))
      .limit(1);

    if (!row) {
      return err(ErrorCode.INVALID_REFERENCE);
    }

    return ok(row);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to load bible text for verse audio',
      context: { bibleTextId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
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
 * Insert-only unit create. On a concurrent first-upload race, reloads the
 * winner instead of overwriting its metadata / version token.
 */
export async function insertRecording(
  input: UpsertVerseAudioInput
): Promise<Result<VerseAudioRecord>> {
  try {
    const [row] = await db
      .insert(verse_audio_recordings)
      .values(input)
      .onConflictDoNothing({
        target: [verse_audio_recordings.projectUnitId, verse_audio_recordings.bibleTextId],
      })
      .returning();

    if (!row) {
      const existing = await get(input.projectUnitId, input.bibleTextId);
      if (!existing.ok) {
        return existing;
      }
      return ok(existing.data);
    }

    const result = await get(row.projectUnitId, row.bibleTextId);
    if (!result.ok) {
      return err(ErrorCode.INTERNAL_ERROR);
    }
    return ok(result.data);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to insert verse audio recording',
      context: { input: { ...input, sizeBytes: input.sizeBytes } },
    });
    if (hasPostgresErrorCode(error, '23503')) {
      return mapForeignKeyViolation(error);
    }
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export type FirstRecordingOutcome = 'created' | 'concurrent' | 'link-conflict';

/**
 * First-upload path as one transaction: insert recording + take + optional
 * active-take link. Prevents a GET between those writes from returning
 * `takes: []` while `downloadUrl` still resolves via `storageObjectId`.
 */
export async function createFirstRecordingWithTake(
  recording: UpsertVerseAudioInput,
  takeInput: Omit<InsertTakeInput, 'recordingId'>
): Promise<
  Result<{ outcome: FirstRecordingOutcome; record: VerseAudioRecord; take: VerseAudioTakeRecord }>
> {
  try {
    return await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(verse_audio_recordings)
        .values(recording)
        .onConflictDoNothing({
          target: [verse_audio_recordings.projectUnitId, verse_audio_recordings.bibleTextId],
        })
        .returning();

      let recordingId: number;
      let concurrent = false;

      if (!inserted) {
        const [existing] = await tx
          .select(recordSelection)
          .from(verse_audio_recordings)
          .innerJoin(bible_texts, eq(verse_audio_recordings.bibleTextId, bible_texts.id))
          .where(
            and(
              eq(verse_audio_recordings.projectUnitId, recording.projectUnitId),
              eq(verse_audio_recordings.bibleTextId, recording.bibleTextId)
            )
          )
          .limit(1);

        if (!existing) {
          return err(ErrorCode.VERSE_AUDIO_NOT_FOUND);
        }
        recordingId = existing.id;
        concurrent = true;
      } else {
        recordingId = inserted.id;
      }

      const [takeRow] = await tx
        .insert(verse_audio_takes)
        .values({ ...takeInput, recordingId })
        .onConflictDoNothing({
          target: [verse_audio_takes.recordingId, verse_audio_takes.contentHash],
        })
        .returning();

      let take: VerseAudioTakeRecord;
      if (takeRow) {
        take = takeRow;
      } else {
        const [existingTake] = await tx
          .select(takeSelection)
          .from(verse_audio_takes)
          .where(
            and(
              eq(verse_audio_takes.recordingId, recordingId),
              eq(verse_audio_takes.contentHash, takeInput.contentHash)
            )
          )
          .limit(1);
        if (!existingTake) {
          return err(ErrorCode.INTERNAL_ERROR);
        }
        take = existingTake;
      }

      const loadRecord = async (): Promise<Result<VerseAudioRecord>> => {
        const [row] = await tx
          .select(recordSelection)
          .from(verse_audio_recordings)
          .innerJoin(bible_texts, eq(verse_audio_recordings.bibleTextId, bible_texts.id))
          .where(eq(verse_audio_recordings.id, recordingId))
          .limit(1);
        if (!row) {
          return err(ErrorCode.INTERNAL_ERROR);
        }
        return ok(row as VerseAudioRecord);
      };

      if (concurrent) {
        const current = await loadRecord();
        if (!current.ok) {
          return current;
        }
        return ok({ outcome: 'concurrent', record: current.data, take });
      }

      const [linked] = await tx
        .update(verse_audio_recordings)
        .set({
          activeTakeId: take.id,
          uploadedBy: takeInput.uploadedBy,
          storageObjectId: takeInput.storageObjectId,
          contentType: takeInput.contentType,
          sizeBytes: takeInput.sizeBytes,
          durationSeconds: takeInput.durationSeconds,
          granularity: take.granularity,
          startChapter: take.startChapter,
          startVerse: take.startVerse,
          endChapter: take.endChapter,
          endVerse: take.endVerse,
          versionToken: 2,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(verse_audio_recordings.id, recordingId),
            eq(verse_audio_recordings.versionToken, 1),
            isNull(verse_audio_recordings.activeTakeId)
          )
        )
        .returning({ id: verse_audio_recordings.id });

      if (linked) {
        const current = await loadRecord();
        if (!current.ok) {
          return current;
        }
        return ok({ outcome: 'created', record: current.data, take });
      }

      const current = await loadRecord();
      if (!current.ok) {
        return current;
      }
      if (current.data.activeTakeId === take.id) {
        return ok({ outcome: 'created', record: current.data, take });
      }

      await tx
        .update(verse_audio_recordings)
        .set({
          conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
          updatedAt: new Date(),
        })
        .where(eq(verse_audio_recordings.id, recordingId));

      const marked = await loadRecord();
      if (!marked.ok) {
        return marked;
      }
      return ok({ outcome: 'link-conflict', record: marked.data, take });
    });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to create first verse audio recording with take',
      context: {
        projectUnitId: recording.projectUnitId,
        bibleTextId: recording.bibleTextId,
        sizeBytes: takeInput.sizeBytes,
      },
    });
    if (hasPostgresErrorCode(error, '23503')) {
      return mapForeignKeyViolation(error);
    }
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

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

export interface UpdateIfVersionOptions {
  /** First-take link: only succeed while no active take is set yet. */
  requireNullActiveTake?: boolean;
}

/**
 * Compare-and-swap update keyed by the observed versionToken. `applied: false`
 * means another writer advanced the version — do not overwrite the newer state.
 */
export async function updateRecordingStateIfVersion(
  recordingId: number,
  expectedVersionToken: number,
  patch: RecordingStatePatch,
  options?: UpdateIfVersionOptions
): Promise<Result<{ applied: boolean; record: VerseAudioRecord | null }>> {
  try {
    const predicates = [
      eq(verse_audio_recordings.id, recordingId),
      eq(verse_audio_recordings.versionToken, expectedVersionToken),
    ];
    if (options?.requireNullActiveTake) {
      predicates.push(isNull(verse_audio_recordings.activeTakeId));
    }

    const [row] = await db
      .update(verse_audio_recordings)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(...predicates))
      .returning();

    if (!row) {
      return ok({ applied: false, record: null });
    }

    const result = await get(row.projectUnitId, row.bibleTextId);
    if (!result.ok) {
      return err(ErrorCode.INTERNAL_ERROR);
    }

    return ok({ applied: true, record: result.data });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to conditionally update verse audio recording state',
      context: { recordingId, expectedVersionToken, patch, options },
    });
    if (hasPostgresErrorCode(error, '23503')) {
      return mapForeignKeyViolation(error);
    }
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
      return mapForeignKeyViolation(error);
    }
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Flag conflict without changing the active take.
 *
 * Atomically increments versionToken and sets conflictStatus to 'conflict',
 * while preserving an intervening 'resolved' status so a racing upload cannot
 * reopen a unit that was just explicitly adjudicated.
 */
export async function markConflictPreservingActive(
  recordingId: number
): Promise<Result<VerseAudioRecord>> {
  try {
    const [row] = await db
      .update(verse_audio_recordings)
      .set({
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
        versionToken: sql`${verse_audio_recordings.versionToken} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(verse_audio_recordings.id, recordingId),
          ne(verse_audio_recordings.conflictStatus, VERSE_AUDIO_CONFLICT_STATUS.RESOLVED)
        )
      )
      .returning();

    if (!row) {
      const [existing] = await db
        .select()
        .from(verse_audio_recordings)
        .where(eq(verse_audio_recordings.id, recordingId))
        .limit(1);

      if (!existing) {
        return err(ErrorCode.VERSE_AUDIO_NOT_FOUND);
      }

      const result = await get(existing.projectUnitId, existing.bibleTextId);
      if (!result.ok) {
        return err(ErrorCode.INTERNAL_ERROR);
      }
      return ok(result.data);
    }

    const result = await get(row.projectUnitId, row.bibleTextId);
    if (!result.ok) {
      return err(ErrorCode.INTERNAL_ERROR);
    }
    return ok(result.data);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to mark verse audio conflict',
      context: { recordingId },
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
