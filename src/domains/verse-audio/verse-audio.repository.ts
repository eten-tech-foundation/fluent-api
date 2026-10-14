import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_texts, verse_audio_recordings, verse_audio_takes } from '@/db/schema';
import { hasPostgresErrorCode } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  InsertTakeInput,
  UpsertVerseAudioInput,
  VerseAudioConflictStatus,
  VerseAudioRecord,
  VerseAudioTakeRecord,
} from './verse-audio.types';

import { mapForeignKeyViolation, takeSelection } from './verse-audio-takes.repository';
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
  activeTakeId: verse_audio_recordings.activeTakeId,
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
 * Flag conflict without touching active take (CAS-miss path).
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
