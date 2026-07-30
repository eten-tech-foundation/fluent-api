import type { Result } from '@/lib/types';

import env from '@/env';
import {
  audioBlobName,
  audioBucket,
  deleteVerseAudio,
  generateAudioDownloadUrl,
  uploadVerseAudio,
} from '@/lib/audio-storage';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  UploadRecordingInput,
  VerseAudioRecord,
  VerseAudioWithUrl,
} from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import * as repo from './verse-audio.repository';
import { ALLOWED_AUDIO_CONTENT_TYPES } from './verse-audio.types';

async function withUrl(record: VerseAudioRecord): Promise<VerseAudioWithUrl> {
  const { storageObjectId: _internal, ...response } = record;
  return {
    ...response,
    downloadUrl: await generateAudioDownloadUrl(
      audioBlobName(record.projectUnitId, record.bibleTextId)
    ),
  };
}

export async function uploadRecording(
  input: UploadRecordingInput
): Promise<Result<VerseAudioWithUrl>> {
  if (!ALLOWED_AUDIO_CONTENT_TYPES.has(input.contentType)) {
    return err(ErrorCode.UNSUPPORTED_AUDIO_TYPE);
  }
  if (input.data.length === 0) {
    return err(ErrorCode.EMPTY_AUDIO_FILE);
  }

  const key = audioBlobName(input.projectUnitId, input.bibleTextId);

  // Claim the storage row BEFORE writing the object: if the write succeeds but
  // this process dies before the metadata row lands, the claim is already there
  // and the reclaim sweep can free the bytes. A claim with no object behind it
  // is harmless — deleting a missing key is a no-op on R2.
  const claim = await storageRepo.claim(audioBucket(), key);
  if (!claim.ok) {
    return claim;
  }

  // Object next, metadata row last. The key is deterministic, so a re-recording
  // overwrites in place and the next successful upload heals any stale row.
  try {
    await uploadVerseAudio(key, input.data, input.contentType);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to upload verse audio object',
      context: { key, contentType: input.contentType, sizeBytes: input.data.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }

  const result = await repo.upsert({
    projectUnitId: input.projectUnitId,
    bibleTextId: input.bibleTextId,
    uploadedBy: input.uploadedBy,
    storageObjectId: claim.data.id,
    contentType: input.contentType,
    sizeBytes: input.data.length,
    durationSeconds: input.durationSeconds ?? null,
  });

  if (!result.ok) {
    return result;
  }

  return ok(await withUrl(result.data));
}

export async function getRecording(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<VerseAudioWithUrl>> {
  const result = await repo.get(projectUnitId, bibleTextId);
  if (!result.ok) {
    return result;
  }
  return ok(await withUrl(result.data));
}

export async function listChapterRecordings(
  projectUnitId: number,
  bookId: number,
  chapterNumber: number
): Promise<Result<VerseAudioWithUrl[]>> {
  const result = await repo.listByChapter(projectUnitId, bookId, chapterNumber);
  if (!result.ok) {
    return result;
  }
  return ok(await Promise.all(result.data.map((recording) => withUrl(recording))));
}

export async function deleteRecording(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<void>> {
  const existing = await repo.get(projectUnitId, bibleTextId);
  if (!existing.ok) {
    return existing;
  }

  // Row first, bytes second. If the row write fails nothing has been destroyed
  // and the caller can retry; if the object delete then fails, the row is
  // already gone so the storage row is an orphan and the sweep collects it.
  // (Deleting bytes first would strand a recording pointing at nothing, which
  // no amount of sweeping can repair.)
  const removed = await repo.remove(projectUnitId, bibleTextId);
  if (!removed.ok) {
    return removed;
  }

  const key = audioBlobName(projectUnitId, bibleTextId);
  try {
    await deleteVerseAudio(key);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Verse audio object delete failed; left for the reclaim sweep',
      context: { key },
    });
    return ok(undefined);
  }

  if (existing.data.storageObjectId !== null) {
    await storageRepo.markDeleted(existing.data.storageObjectId);
  }

  return ok(undefined);
}

/**
 * Deletes objects nothing references any more and stamps their rows.
 *
 * This is the counterpart to the cascade: dropping a project unit cascades its
 * recordings away, but Postgres cannot touch a bucket, so without this the audio
 * would sit there forever. Runs on an interval from the server entrypoint.
 */
export async function reclaimOrphanedStorageObjects(): Promise<Result<number>> {
  const orphans = await storageRepo.findOrphans(env.AUDIO_RECLAIM_GRACE_MS);
  if (!orphans.ok) {
    return orphans;
  }

  let reclaimed = 0;
  for (const orphan of orphans.data) {
    try {
      await deleteVerseAudio(orphan.key);
    } catch (error) {
      // Leave the row unstamped so the next sweep retries this object.
      logger.error({
        cause: error,
        message: 'Failed to reclaim orphaned storage object',
        context: { bucket: orphan.bucket, key: orphan.key },
      });
      continue;
    }
    await storageRepo.markDeleted(orphan.id);
    reclaimed++;
  }

  if (reclaimed > 0) {
    logger.info('Reclaimed orphaned verse audio objects', { reclaimed });
  }
  return ok(reclaimed);
}
