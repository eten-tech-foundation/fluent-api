import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { bible_texts } from '@/db/schema';
import { err, ErrorCode, ok } from '@/lib/types';

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
    } as never);

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

  describe('updateTakeCoverageAndRecordingIfVersion', () => {
    const shape = {
      granularity: 'pericope' as const,
      startChapter: 1,
      startVerse: 3,
      endChapter: 1,
      endVerse: 10,
    };

    function chainUpdate(returningRows: unknown[]) {
      return {
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(returningRows),
          }),
        }),
      };
    }

    it('rolls back the take write when recording CAS misses (txn abort)', async () => {
      let takeWriteVisible = false;
      const tx = {
        update: vi
          .fn()
          .mockImplementationOnce(() => {
            // Take coverage write lands first inside the txn.
            takeWriteVisible = true;
            return chainUpdate([{ id: 10 }]);
          })
          .mockImplementationOnce(() => {
            // Recording version predicate misses — empty returning.
            return chainUpdate([]);
          }),
        select: vi.fn(),
      };

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        try {
          return await callback(tx as never);
        } catch (error) {
          // Drizzle/Postgres would roll back uncommitted take coverage here.
          takeWriteVisible = false;
          throw error;
        }
      });

      const result = await repo.updateTakeCoverageAndRecordingIfVersion(10, 1, 2, shape, {
        versionToken: 3,
        ...shape,
      });

      expect(result).toEqual(ok({ applied: false, record: null }));
      expect(takeWriteVisible).toBe(false);
      expect(tx.update).toHaveBeenCalledTimes(2);
      expect(tx.select).not.toHaveBeenCalled();
    });

    it('applies take coverage and recording patch in one transaction on CAS hit', async () => {
      const hydrated = {
        id: 1,
        projectUnitId: 12,
        bibleTextId: 3401,
        versionToken: 3,
        ...shape,
      };
      const tx = {
        update: vi
          .fn()
          .mockImplementationOnce(() => chainUpdate([{ id: 10 }]))
          .mockImplementationOnce(() =>
            chainUpdate([{ id: 1, projectUnitId: 12, bibleTextId: 3401 }])
          ),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([hydrated]),
              }),
            }),
          }),
        }),
      };
      vi.mocked(db.transaction).mockImplementation(async (callback) => callback(tx as never));

      const result = await repo.updateTakeCoverageAndRecordingIfVersion(10, 1, 2, shape, {
        versionToken: 3,
        ...shape,
      });

      expect(result).toEqual(ok({ applied: true, record: hydrated }));
      expect(tx.update).toHaveBeenCalledTimes(2);
      expect(tx.select).toHaveBeenCalledTimes(1);
    });

    it('rolls back both writes when post-CAS hydration is missing (throws, not Result)', async () => {
      let writesCommitted = false;
      const tx = {
        update: vi
          .fn()
          .mockImplementationOnce(() => chainUpdate([{ id: 10 }]))
          .mockImplementationOnce(() =>
            chainUpdate([{ id: 1, projectUnitId: 12, bibleTextId: 3401 }])
          ),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      };

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        try {
          const value = await callback(tx as never);
          // Drizzle commits when the callback resolves (including ok:false Results).
          writesCommitted = true;
          return value;
        } catch (error) {
          // Abort path — uncommitted take+recording writes are discarded.
          writesCommitted = false;
          throw error;
        }
      });

      const result = await repo.updateTakeCoverageAndRecordingIfVersion(10, 1, 2, shape, {
        versionToken: 3,
        ...shape,
      });

      expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
      expect(writesCommitted).toBe(false);
      expect(tx.update).toHaveBeenCalledTimes(2);
    });
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
      vi.mocked(db.select).mockReturnValue({ from } as never);
    }

    it('sets conflict status and advances version token when not resolved', async () => {
      const returning = vi.fn().mockResolvedValue([{ id: 1, projectUnitId: 10, bibleTextId: 20 }]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      vi.mocked(db.update).mockReturnValue({ set } as never);

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
