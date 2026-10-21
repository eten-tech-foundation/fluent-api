import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
  UploadRecordingInput,
  VerseAudioRecord,
  VerseAudioTakeRecord,
} from './verse-audio.types';

import { VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

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
  activeTakeId: 10,
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
