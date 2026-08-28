import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_texts, verse_audio_recordings, verse_audio_takes } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  InsertTakeInput,
  UpsertVerseAudioInput,
  VerseAudioConflictStatus,
  VerseAudioRecord,
  VerseAudioTakeRecord,
} from './verse-audio.types';

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
  activeTakeId: verse_audio_recordings.activeTakeId,
  createdAt: verse_audio_recordings.createdAt,
  updatedAt: verse_audio_recordings.updatedAt,
  verseNumber: bible_texts.verseNumber,
};

const takeSelection = {
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

    return ok(recordings as VerseAudioRecord[]);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to list verse audio recordings',
      context: { projectUnitId, bookId, chapterNumber },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

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

export async function updateRecordingState(
  recordingId: number,
  patch: RecordingStatePatch
): Promise<Result<VerseAudioRecord>> {
  try {
    const [row] = await db
      .update(verse_audio_recordings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(verse_audio_recordings.id, recordingId))
      .returning();

    if (!row) {
      return err(ErrorCode.VERSE_AUDIO_NOT_FOUND);
    }

    const result = await get(row.projectUnitId, row.bibleTextId);
    if (!result.ok) {
      return err(ErrorCode.INTERNAL_ERROR);
    }

    return ok(result.data);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to update verse audio recording state',
      context: { recordingId, patch },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
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
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/** Flag conflict without touching versionToken / active take (CAS-miss path). */
export async function markConflictPreservingActive(
  recordingId: number
): Promise<Result<VerseAudioRecord>> {
  try {
    const [row] = await db
      .update(verse_audio_recordings)
      .set({
        conflictStatus: 'conflict',
        updatedAt: new Date(),
      })
      .where(eq(verse_audio_recordings.id, recordingId))
      .returning();

    if (!row) {
      return err(ErrorCode.VERSE_AUDIO_NOT_FOUND);
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

export async function listTakesForRecording(
  recordingId: number
): Promise<Result<VerseAudioTakeRecord[]>> {
  return listTakesByRecordingIds([recordingId]);
}

/**
 * Drops superseded takes: non-active takes on a clean unit that has been settled
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
 * delete, and the delete re-evaluates the "not active, still clean" predicate
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
            eq(verse_audio_recordings.conflictStatus, VERSE_AUDIO_CONFLICT_STATUS.CLEAN),
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
                AND r.conflict_status = ${VERSE_AUDIO_CONFLICT_STATUS.CLEAN}
                AND r.active_take_id IS NOT NULL
                AND r.active_take_id <> ${verse_audio_takes.id}
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
