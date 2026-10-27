import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import { verse_audio_recordings, verse_audio_takes } from '@/db/schema';
import { hasPostgresErrorCode } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { InsertTakeInput, VerseAudioTakeRecord } from './verse-audio.types';

import { mapForeignKeyViolation } from './verse-audio.errors';
import { VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

type Executor = typeof db | DbTransaction;

interface LockedRecording {
  id: number;
  activeTakeId: number | null;
  versionToken: number;
}

interface DeletedTakeRow {
  storageObjectId: number | null;
  contentHash: string;
}

export const takeSelection = {
  id: verse_audio_takes.id,
  recordingId: verse_audio_takes.recordingId,
  uploadedBy: verse_audio_takes.uploadedBy,
  storageObjectId: verse_audio_takes.storageObjectId,
  contentType: verse_audio_takes.contentType,
  sizeBytes: verse_audio_takes.sizeBytes,
  durationSeconds: verse_audio_takes.durationSeconds,
  contentHash: verse_audio_takes.contentHash,
  granularity: verse_audio_takes.granularity,
  startChapter: verse_audio_takes.startChapter,
  startVerse: verse_audio_takes.startVerse,
  endChapter: verse_audio_takes.endChapter,
  endVerse: verse_audio_takes.endVerse,
  createdAt: verse_audio_takes.createdAt,
  updatedAt: verse_audio_takes.updatedAt,
};

export async function listTakesByRecordingIds(
  recordingIds: number[]
): Promise<Result<VerseAudioTakeRecord[]>> {
  if (recordingIds.length === 0) {
    return ok([]);
  }

  try {
    const takes = await db
      .select(takeSelection)
      .from(verse_audio_takes)
      .where(inArray(verse_audio_takes.recordingId, recordingIds))
      .orderBy(asc(verse_audio_takes.createdAt), asc(verse_audio_takes.id));

    return ok(takes);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to list verse audio takes',
      context: { recordingIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findTakeByContentHash(
  recordingId: number,
  contentHash: string
): Promise<Result<VerseAudioTakeRecord | null>> {
  try {
    const [take] = await db
      .select(takeSelection)
      .from(verse_audio_takes)
      .where(
        and(
          eq(verse_audio_takes.recordingId, recordingId),
          eq(verse_audio_takes.contentHash, contentHash)
        )
      )
      .limit(1);

    return ok(take ?? null);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to find verse audio take by content hash',
      context: { recordingId, contentHash },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getTakeById(takeId: number): Promise<Result<VerseAudioTakeRecord>> {
  try {
    const [take] = await db
      .select(takeSelection)
      .from(verse_audio_takes)
      .where(eq(verse_audio_takes.id, takeId))
      .limit(1);

    if (!take) {
      return err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND);
    }

    return ok(take);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get verse audio take',
      context: { takeId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function insertTake(input: InsertTakeInput): Promise<Result<VerseAudioTakeRecord>> {
  try {
    const [row] = await db
      .insert(verse_audio_takes)
      .values(input)
      .onConflictDoNothing({
        target: [verse_audio_takes.recordingId, verse_audio_takes.contentHash],
      })
      .returning();

    if (row) {
      return ok(row);
    }

    // Concurrent insert of the same content hash — return the existing take.
    const existing = await findTakeByContentHash(input.recordingId, input.contentHash);
    if (!existing.ok) {
      return existing;
    }
    if (!existing.data) {
      return err(ErrorCode.INTERNAL_ERROR);
    }
    return ok(existing.data);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to insert verse audio take',
      context: { input: { ...input, sizeBytes: input.sizeBytes } },
    });
    if (hasPostgresErrorCode(error, '23503')) {
      return mapForeignKeyViolation(error);
    }
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/** Lock the recording row so delete + promote/clear stay serialised. */
export async function lockRecording(
  recordingId: number,
  tx: DbTransaction
): Promise<Result<LockedRecording>> {
  try {
    const [recording] = await tx
      .select({
        id: verse_audio_recordings.id,
        activeTakeId: verse_audio_recordings.activeTakeId,
        versionToken: verse_audio_recordings.versionToken,
      })
      .from(verse_audio_recordings)
      .where(eq(verse_audio_recordings.id, recordingId))
      .for('update');
    if (!recording) {
      return err(ErrorCode.VERSE_AUDIO_NOT_FOUND);
    }
    return ok(recording);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to lock verse audio recording',
      context: { recordingId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/** Delete one take row belonging to `recordingId`. */
export async function deleteTake(
  recordingId: number,
  takeId: number,
  tx: DbTransaction
): Promise<Result<DeletedTakeRow>> {
  try {
    const [deleted] = await tx
      .delete(verse_audio_takes)
      .where(and(eq(verse_audio_takes.id, takeId), eq(verse_audio_takes.recordingId, recordingId)))
      .returning({
        storageObjectId: verse_audio_takes.storageObjectId,
        contentHash: verse_audio_takes.contentHash,
      });
    if (!deleted) {
      return err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND);
    }
    return ok(deleted);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to delete verse audio take',
      context: { recordingId, takeId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * CAS-promote or clear the active take. `conflictStatus` is intentionally left
 * alone (delete-while-conflict keeps the flag; coverage is not re-checked).
 */
export async function setActiveTake(
  recordingId: number,
  take: VerseAudioTakeRecord | null,
  expectedVersionToken: number,
  tx: DbTransaction
): Promise<Result<{ applied: boolean }>> {
  try {
    const [row] = await tx
      .update(verse_audio_recordings)
      .set(
        take
          ? {
              activeTakeId: take.id,
              uploadedBy: take.uploadedBy,
              storageObjectId: take.storageObjectId,
              contentType: take.contentType,
              sizeBytes: take.sizeBytes,
              durationSeconds: take.durationSeconds,
              granularity: take.granularity,
              startChapter: take.startChapter,
              startVerse: take.startVerse,
              endChapter: take.endChapter,
              endVerse: take.endVerse,
              versionToken: expectedVersionToken + 1,
              updatedAt: new Date(),
            }
          : {
              activeTakeId: null,
              storageObjectId: null,
              versionToken: expectedVersionToken + 1,
              updatedAt: new Date(),
            }
      )
      .where(
        and(
          eq(verse_audio_recordings.id, recordingId),
          eq(verse_audio_recordings.versionToken, expectedVersionToken)
        )
      )
      .returning({ id: verse_audio_recordings.id });

    return ok({ applied: row !== undefined });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to set verse audio active take',
      context: { recordingId, takeId: take?.id ?? null, expectedVersionToken },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function listTakesForRecording(
  recordingId: number,
  executor: Executor = db
): Promise<Result<VerseAudioTakeRecord[]>> {
  try {
    const takes = await executor
      .select(takeSelection)
      .from(verse_audio_takes)
      .where(eq(verse_audio_takes.recordingId, recordingId))
      .orderBy(asc(verse_audio_takes.createdAt), asc(verse_audio_takes.id));

    return ok(takes);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to list verse audio takes for recording',
      context: { recordingId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Drops superseded takes: non-active takes on a clean or resolved unit that has been settled
 * on its active take for the whole retention window.
 *
 * Only take rows go; the objects they referenced are left to the orphan pass,
 * which already skips anything a take or recording still points at and honours
 * its own grace window. Deleting blobs here instead would race a concurrent
 * upload of the same bytes, which revives the very `storage_objects` row (unique
 * on bucket+key) this sweep is about to stamp deleted.
 *
 * `active_take_id` is `ON DELETE set null`, so nothing at the schema level stops
 * a take promoted mid-sweep from being deleted out from under its recording.
 * Two guards close that window: the parent recordings are locked before the
 * delete, and the delete re-evaluates the "not active, still clean or resolved" predicate
 * under that lock rather than trusting the candidate snapshot.
 */
export async function pruneSupersededTakes(
  retentionMs: number,
  limit = 500
): Promise<Result<number>> {
  try {
    const cutoff = new Date(Date.now() - retentionMs);

    return await db.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: verse_audio_takes.id, recordingId: verse_audio_takes.recordingId })
        .from(verse_audio_takes)
        .innerJoin(
          verse_audio_recordings,
          eq(verse_audio_takes.recordingId, verse_audio_recordings.id)
        )
        .where(
          and(
            inArray(verse_audio_recordings.conflictStatus, [
              VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
              VERSE_AUDIO_CONFLICT_STATUS.RESOLVED,
            ]),
            isNotNull(verse_audio_recordings.activeTakeId),
            ne(verse_audio_takes.id, verse_audio_recordings.activeTakeId),
            lt(verse_audio_takes.createdAt, cutoff),
            // The unit itself has been untouched for the window. Promoting a take
            // stamps the recording, so this is "settled since", not "created before".
            lt(verse_audio_recordings.updatedAt, cutoff)
          )
        )
        .orderBy(asc(verse_audio_takes.id))
        .limit(limit);

      if (candidates.length === 0) {
        return ok(0);
      }

      // Ordered lock so concurrent sweeps cannot deadlock against each other, and
      // an upload promoting one of these takes serialises behind us.
      const recordingIds = [...new Set(candidates.map((c) => c.recordingId))].sort((a, b) => a - b);
      await tx
        .select({ id: verse_audio_recordings.id })
        .from(verse_audio_recordings)
        .where(inArray(verse_audio_recordings.id, recordingIds))
        .orderBy(asc(verse_audio_recordings.id))
        .for('update');

      const deleted = await tx
        .delete(verse_audio_takes)
        .where(
          and(
            inArray(
              verse_audio_takes.id,
              candidates.map((c) => c.id)
            ),
            sql`EXISTS (
              SELECT 1 FROM ${verse_audio_recordings} r
              WHERE r.id = ${verse_audio_takes.recordingId}
                AND r.conflict_status IN (${VERSE_AUDIO_CONFLICT_STATUS.CLEAN}, ${VERSE_AUDIO_CONFLICT_STATUS.RESOLVED})
                AND r.active_take_id IS NOT NULL
                AND r.active_take_id <> ${verse_audio_takes.id}
                AND r.updated_at < ${cutoff}
            )`
          )
        )
        .returning({ id: verse_audio_takes.id });

      return ok(deleted.length);
    });
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to prune superseded verse audio takes' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
