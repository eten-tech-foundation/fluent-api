import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { verse_audio_recordings, verse_audio_takes } from '@/db/schema';
import { hasPostgresErrorCode } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { InsertTakeInput, VerseAudioTakeRecord } from './verse-audio.types';

import { mapForeignKeyViolation } from './verse-audio.errors';
import { VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

export const takeSelection = {
  id: verse_audio_takes.id,
  recordingId: verse_audio_takes.recordingId,
  uploadedBy: verse_audio_takes.uploadedBy,
  storageObjectId: verse_audio_takes.storageObjectId,
  contentType: verse_audio_takes.contentType,
  sizeBytes: verse_audio_takes.sizeBytes,
  durationSeconds: verse_audio_takes.durationSeconds,
  contentHash: verse_audio_takes.contentHash,
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

export async function listTakesForRecording(
  recordingId: number
): Promise<Result<VerseAudioTakeRecord[]>> {
  return listTakesByRecordingIds([recordingId]);
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
