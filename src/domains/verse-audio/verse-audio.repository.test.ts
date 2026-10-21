import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { bible_texts } from '@/db/schema';
import { err, ErrorCode } from '@/lib/types';

import * as repo from './verse-audio.repository';

vi.mock('@/db', () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((...args) => args),
    ne: vi.fn((...args) => args),
    and: vi.fn((...args) => args),
    sql: vi.fn((...args) => args),
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}));

function foreignKeyRace(constraint: string) {
  return new Error('query failed', {
    cause: { code: '23503', constraint },
  });
}

describe('verse-audio repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters chapter listings by Bible as well as book and chapter', async () => {
    const orderBy = vi.fn().mockResolvedValue([]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ orderBy }),
        }),
      }),
    } as any);

    const result = await repo.listByChapter(12, 9, 1, 4);

    expect(result).toEqual({ ok: true, data: [] });
    expect(eq).toHaveBeenCalledWith(bible_texts.bibleId, 9);
  });

  it('maps a reclaimed storage object during take insert to 409', async () => {
    vi.mocked(db.insert).mockImplementation(() => {
      throw foreignKeyRace('verse_audio_takes_storage_object_id_storage_objects_id_fk');
    });

    const result = await repo.insertTake({
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

    const result = await repo.insertTake({
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

  it('maps a reclaimed storage object during first recording insert to 409', async () => {
    vi.mocked(db.insert).mockImplementation(() => {
      throw foreignKeyRace('verse_audio_recordings_storage_object_id_storage_objects_id_fk');
    });

    const result = await repo.insertRecording({
      projectUnitId: 1,
      bibleTextId: 2,
      uploadedBy: 3,
      storageObjectId: 4,
      contentType: 'audio/mp4',
      sizeBytes: 5,
      durationSeconds: null,
      versionToken: 1,
      conflictStatus: 'clean',
      activeTakeId: null,
    });

    expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT));
  });

  it('maps a pruned active take during conditional promotion to 409', async () => {
    vi.mocked(db.update).mockImplementation(() => {
      throw foreignKeyRace('verse_audio_recordings_active_take_id_verse_audio_takes_id_fk');
    });

    const result = await repo.updateRecordingStateIfVersion(1, 2, {
      activeTakeId: 3,
      versionToken: 3,
    });

    expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT));
  });

  describe('markConflictPreservingActive', () => {
    const mockRecord = {
      id: 1,
      projectUnitId: 10,
      bibleTextId: 20,
      uploadedBy: 1,
      storageObjectId: 1,
      contentType: 'audio/mp4',
      sizeBytes: 100,
      durationSeconds: 5,
      versionToken: 3,
      conflictStatus: 'conflict',
      activeTakeId: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    function mockSelect(record: any) {
      const limit = vi.fn().mockResolvedValue(record ? [record] : []);
      const where = vi.fn().mockReturnValue({ limit });
      const innerJoin = vi.fn().mockReturnValue({ where });
      const from = vi.fn().mockReturnValue({ innerJoin, where });
      vi.mocked(db.select).mockReturnValue({ from } as any);
    }

    it('sets conflict status and advances version token when not resolved', async () => {
      const returning = vi.fn().mockResolvedValue([{ id: 1, projectUnitId: 10, bibleTextId: 20 }]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      vi.mocked(db.update).mockReturnValue({ set } as any);

      mockSelect(mockRecord);

      const result = await repo.markConflictPreservingActive(1);

      expect(result).toEqual({ ok: true, data: mockRecord });
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          conflictStatus: 'conflict',
        })
      );
    });

    it('preserves resolved status when conflictStatus was resolved', async () => {
      // update returns empty array because where condition excluded 'resolved'
      const returning = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      vi.mocked(db.update).mockReturnValue({ set } as any);

      const resolvedRecord = { ...mockRecord, conflictStatus: 'resolved' };
      mockSelect(resolvedRecord);

      const result = await repo.markConflictPreservingActive(1);

      expect(result).toEqual({ ok: true, data: resolvedRecord });
    });

    it('returns 404 when recording does not exist', async () => {
      const returning = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      vi.mocked(db.update).mockReturnValue({ set } as any);

      mockSelect(null);

      const result = await repo.markConflictPreservingActive(1);

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
    });
  });
});
