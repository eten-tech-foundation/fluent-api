import type { Result } from '@/lib/types';

import { deleteVerseAudio } from '@/lib/audio-storage';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  ResolveConflictInput,
  VerseAudioTakeRecord,
  VerseAudioWithUrl,
} from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import * as repo from './verse-audio.repository';
import {
  buildRecordingResponses,
  fallbackBlobKey,
  loadUnitResponse,
} from './verse-audio.responses';
import { shapeFromTake } from './verse-audio.shapes';
import { VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

export { reclaimOrphanedStorageObjects } from './verse-audio.reclaim.service';
export { uploadRecording } from './verse-audio.upload.service';

export async function getRecording(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<VerseAudioWithUrl>> {
  return loadUnitResponse(projectUnitId, bibleTextId);
}

/** Lightweight reload for 409 retry hints — no presigns or take hydration. */
export async function getCurrentVersionToken(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<number>> {
  const recording = await repo.get(projectUnitId, bibleTextId);
  if (!recording.ok) {
    return recording;
  }
  return ok(recording.data.versionToken);
}

export async function listChapterRecordings(
  projectUnitId: number,
  bibleId: number,
  bookId: number,
  chapterNumber: number
): Promise<Result<{ items: VerseAudioWithUrl[]; hasConflict: boolean }>> {
  const result = await repo.listByChapter(projectUnitId, bibleId, bookId, chapterNumber);
  if (!result.ok) {
    return result;
  }

  const takes = await repo.listTakesByRecordingIds(result.data.map((r) => r.id));
  if (!takes.ok) {
    return takes;
  }

  const takesByRecording = new Map<number, VerseAudioTakeRecord[]>();
  for (const take of takes.data) {
    const list = takesByRecording.get(take.recordingId) ?? [];
    list.push(take);
    takesByRecording.set(take.recordingId, list);
  }

  const items = await buildRecordingResponses(
    result.data.map((record) => ({
      record,
      takes: takesByRecording.get(record.id) ?? [],
    }))
  );

  const hasConflict = items.some(
    (item) => item.conflictStatus === VERSE_AUDIO_CONFLICT_STATUS.CONFLICT
  );

  return ok({ items, hasConflict });
}

export async function resolveConflict(
  input: ResolveConflictInput
): Promise<Result<VerseAudioWithUrl>> {
  const recording = await repo.get(input.projectUnitId, input.bibleTextId);
  if (!recording.ok) {
    return recording;
  }

  const take = await repo.getTakeById(input.takeId);
  if (!take.ok) {
    return take;
  }
  if (take.data.recordingId !== recording.data.id) {
    return err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND);
  }

  // Reject resolve on units that are not actively conflicted. Allowing it would
  // silently stamp 'resolved' on a clean or already-resolved unit, which makes
  // clients show "conflict resolved" when no conflict ever existed (or was
  // already settled). The caller should reload and check conflictStatus first.
  if (recording.data.conflictStatus !== VERSE_AUDIO_CONFLICT_STATUS.CONFLICT) {
    return err(ErrorCode.VERSE_AUDIO_NOT_IN_CONFLICT);
  }

  const updated = await repo.updateRecordingStateIfVersion(
    recording.data.id,
    recording.data.versionToken,
    {
      uploadedBy: take.data.uploadedBy,
      storageObjectId: take.data.storageObjectId,
      contentType: take.data.contentType,
      sizeBytes: take.data.sizeBytes,
      durationSeconds: take.data.durationSeconds,
      activeTakeId: take.data.id,
      conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.RESOLVED,
      versionToken: recording.data.versionToken + 1,
      ...shapeFromTake(take.data),
    }
  );
  if (!updated.ok) {
    return updated;
  }
  if (!updated.data.applied) {
    // Concurrent upload advanced the token — client should reload and retry.
    return err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT);
  }

  return loadUnitResponse(input.projectUnitId, input.bibleTextId);
}

export async function deleteRecording(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<void>> {
  const existing = await repo.get(projectUnitId, bibleTextId);
  if (!existing.ok) {
    return existing;
  }

  const takes = await repo.listTakesForRecording(existing.data.id);
  if (!takes.ok) {
    return takes;
  }

  // Row first (cascades takes), bytes second. If the row write fails nothing has
  // been destroyed and the caller can retry; if an object delete then fails, the
  // storage row is an orphan and the sweep collects it.
  const removed = await repo.remove(projectUnitId, bibleTextId);
  if (!removed.ok) {
    return removed;
  }

  for (const take of takes.data) {
    if (take.storageObjectId === null) {
      continue;
    }
    const storage = await storageRepo.getById(take.storageObjectId);
    const key = storage.ok
      ? storage.data.key
      : fallbackBlobKey(projectUnitId, bibleTextId, take.contentHash);

    try {
      await deleteVerseAudio(key);
    } catch (error) {
      logger.error({
        cause: error,
        message: 'Verse audio object delete failed; left for the reclaim sweep',
        context: { key },
      });
      continue;
    }

    await storageRepo.markDeleted(take.storageObjectId);
  }

  return ok(undefined);
}

/**
 * Deletes objects nothing references any more and stamps their rows.
 *
 * Runs in two independent phases. First it drops superseded takes on settled
 * clean units: hash-keyed blobs are per-take, so without this a verse re-recorded
 * ten times would keep ten objects forever. Conflicted units are left intact
 * until resolve. That phase only deletes take rows — the objects they freed fall
 * to the orphan pass on a later sweep, which is what keeps a concurrent
 * re-upload of the same bytes from having its revived row stamped deleted.
 *
 * The orphan pass is the counterpart to the cascade: dropping a project unit
 * cascades its recordings away, but Postgres cannot touch a bucket, so without
 * this the audio would sit there forever. Runs on an interval from the server
 * entrypoint.
 */
