import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { err, ErrorCode } from '@/lib/types';

import * as takesRepo from './verse-audio-takes.repository';

vi.mock('@/db', () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}));

function foreignKeyRace(constraint: string) {
  return new Error('query failed', {
    cause: { code: '23503', constraint },
  });
}

describe('verse-audio-takes repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps a reclaimed storage object during take insert to 409', async () => {
    vi.mocked(db.insert).mockImplementation(() => {
      throw foreignKeyRace('verse_audio_takes_storage_object_id_storage_objects_id_fk');
    });

    const result = await takesRepo.insertTake({
      recordingId: 1,
      uploadedBy: 2,
      storageObjectId: 3,
      contentType: 'audio/mp4',
      sizeBytes: 4,
      durationSeconds: null,
      contentHash: 'a'.repeat(64),
    });

    expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT));
  });

  it('maps a missing recording FK during take insert to 404', async () => {
    vi.mocked(db.insert).mockImplementation(() => {
      throw foreignKeyRace('verse_audio_takes_recording_id_verse_audio_recordings_id_fk');
    });

    const result = await takesRepo.insertTake({
      recordingId: 1,
      uploadedBy: 2,
      storageObjectId: 3,
      contentType: 'audio/mp4',
      sizeBytes: 4,
      durationSeconds: null,
      contentHash: 'a'.repeat(64),
    });

    expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
  });

  it('returns empty array when listing takes for empty recording IDs', async () => {
    const result = await takesRepo.listTakesByRecordingIds([]);
    expect(result).toEqual({ ok: true, data: [] });
    expect(db.select).not.toHaveBeenCalled();
  });
});
