import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
  UploadRecordingInput,
  VerseAudioRecord,
  VerseAudioTakeRecord,
  VerseAudioTakeWithUrl,
  VerseAudioWithUrl,
} from './verse-audio.types';

import { VERSE_AUDIO_CONFLICT_STATUS, VERSE_AUDIO_GRANULARITY } from './verse-audio.types';

export const hashOf = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export const record: VerseAudioRecord = {
  id: 1,
  projectUnitId: 12,
  bibleTextId: 3401,
  uploadedBy: 7,
  storageObjectId: 55,
  contentType: 'audio/mp4',
  sizeBytes: 4,
  durationSeconds: 12.5,
  versionToken: 1,
  conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
  granularity: VERSE_AUDIO_GRANULARITY.VERSE,
  startChapter: null,
  startVerse: null,
  endChapter: null,
  endVerse: null,
  activeTakeId: 10,
  bookId: 40,
  chapterNumber: 1,
  verseNumber: 3,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

export const take: VerseAudioTakeRecord = {
  id: 10,
  recordingId: 1,
  uploadedBy: 7,
  storageObjectId: 55,
  contentType: 'audio/mp4',
  sizeBytes: 4,
  durationSeconds: 12.5,
  contentHash: hashOf(Buffer.from('abcd')),
  granularity: VERSE_AUDIO_GRANULARITY.VERSE,
  startChapter: null,
  startVerse: null,
  endChapter: null,
  endVerse: null,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

export const uploadInput: UploadRecordingInput = {
  projectUnitId: 12,
  bibleTextId: 3401,
  uploadedBy: 7,
  contentType: 'audio/mp4',
  data: Buffer.from('abcd'),
  durationSeconds: 12.5,
};

const takeWithUrl: VerseAudioTakeWithUrl = {
  id: take.id,
  uploadedBy: take.uploadedBy,
  contentType: take.contentType,
  sizeBytes: take.sizeBytes,
  durationSeconds: take.durationSeconds,
  contentHash: take.contentHash,
  granularity: take.granularity,
  startChapter: take.startChapter,
  startVerse: take.startVerse,
  endChapter: take.endChapter,
  endVerse: take.endVerse,
  downloadUrl: 'https://r2.example/k-55?sig=x',
  createdAt: take.createdAt.toISOString(),
  updatedAt: take.updatedAt.toISOString(),
};

/** Full route/service response fixture — prefer over partial casts. */
export const recordWithUrl: VerseAudioWithUrl = {
  id: record.id,
  projectUnitId: record.projectUnitId,
  bibleTextId: record.bibleTextId,
  uploadedBy: record.uploadedBy,
  contentType: record.contentType,
  sizeBytes: record.sizeBytes,
  durationSeconds: record.durationSeconds,
  versionToken: record.versionToken,
  conflictStatus: record.conflictStatus,
  granularity: record.granularity,
  startChapter: record.chapterNumber,
  startVerse: record.verseNumber,
  endChapter: record.chapterNumber,
  endVerse: record.verseNumber,
  activeTakeId: record.activeTakeId,
  verseNumber: record.verseNumber,
  downloadUrl: takeWithUrl.downloadUrl,
  takes: [takeWithUrl],
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
};
