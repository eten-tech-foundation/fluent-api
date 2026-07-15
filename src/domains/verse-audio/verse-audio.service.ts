import type { Result } from '@/lib/types';

import {
  audioBlobName,
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

import * as repo from './verse-audio.repository';
import { ALLOWED_AUDIO_CONTENT_TYPES } from './verse-audio.types';

function withUrl(record: VerseAudioRecord): VerseAudioWithUrl {
  return {
    ...record,
    downloadUrl: generateAudioDownloadUrl(audioBlobName(record.projectUnitId, record.bibleTextId)),
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

  const blobName = audioBlobName(input.projectUnitId, input.bibleTextId);

  // Blob first, row second: if the row write fails the blob holds the new
  // bytes with stale metadata, and the next successful upload heals it
  // (deterministic name ⇒ in-place overwrite).
  try {
    await uploadVerseAudio(blobName, input.data, input.contentType);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to upload verse audio blob',
      context: { blobName, contentType: input.contentType, sizeBytes: input.data.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }

  const result = await repo.upsert({
    projectUnitId: input.projectUnitId,
    bibleTextId: input.bibleTextId,
    uploadedBy: input.uploadedBy,
    contentType: input.contentType,
    sizeBytes: input.data.length,
    durationSeconds: input.durationSeconds ?? null,
  });

  if (!result.ok) {
    return result;
  }

  return ok(withUrl(result.data));
}

export async function getRecording(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<VerseAudioWithUrl>> {
  const result = await repo.get(projectUnitId, bibleTextId);
  if (!result.ok) {
    return result;
  }
  return ok(withUrl(result.data));
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
  return ok(result.data.map((recording) => withUrl(recording)));
}

export async function deleteRecording(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<void>> {
  const existing = await repo.get(projectUnitId, bibleTextId);
  if (!existing.ok) {
    return existing;
  }

  const blobName = audioBlobName(projectUnitId, bibleTextId);
  try {
    await deleteVerseAudio(blobName);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to delete verse audio blob',
      context: { blobName },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }

  return repo.remove(projectUnitId, bibleTextId);
}
