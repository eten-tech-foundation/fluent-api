import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { bible_texts } from '@/db/schema';
import { err, ErrorCode, ok } from '@/lib/types';

import * as repo from './verse-audio.repository';

vi.mock('@/db', () => ({
  db: {
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
    inArray: vi.fn((...args) => args),
    asc: vi.fn((...args) => args),
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

    it('rolls back both writes when post-CAS hydration is missing (runInTransaction abort)', async () => {
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
          // Drizzle commits when the callback resolves without throwing.
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

  describe('markIntersectingCoverageConflicts', () => {
    function mockLockedRows(rows: unknown[]) {
      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  for: vi.fn().mockResolvedValue(rows),
                }),
              }),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: updateWhere }),
        }),
      };
      vi.mocked(db.transaction).mockImplementation(async (callback) => callback(tx as never));
      return { tx, updateWhere };
    }

    const coverage = { start: { chapter: 1, verse: 1 }, end: { chapter: 1, verse: 5 } };

    it('does not re-flag resolved units when marking intersecting coverage', async () => {
      const { ne } = await import('drizzle-orm');
      const self = {
        id: 1,
        bibleTextId: 100,
        bookId: 40,
        chapterNumber: 1,
        verseNumber: 1,
        conflictStatus: 'clean',
        granularity: 'verse',
        startChapter: null,
        startVerse: null,
        endChapter: null,
        endVerse: null,
      };
      const resolvedOverlap = {
        id: 2,
        bibleTextId: 101,
        bookId: 40,
        chapterNumber: 1,
        verseNumber: 2,
        conflictStatus: 'resolved',
        granularity: 'verse',
        startChapter: null,
        startVerse: null,
        endChapter: null,
        endVerse: null,
      };
      const cleanOverlap = {
        id: 3,
        bibleTextId: 102,
        bookId: 40,
        chapterNumber: 1,
        verseNumber: 3,
        conflictStatus: 'clean',
        granularity: 'verse',
        startChapter: null,
        startVerse: null,
        endChapter: null,
        endVerse: null,
      };

      const { tx, updateWhere } = mockLockedRows([self, resolvedOverlap, cleanOverlap]);

      const result = await repo.markIntersectingCoverageConflicts({
        projectUnitId: 12,
        selfBibleTextId: 100,
        bookId: 40,
        coverage,
      });

      // Resolved overlap (id 2) excluded from toMark; UPDATE also guards with ne(resolved).
      expect(result).toEqual(ok({ markedIds: [1, 3] }));
      expect(tx.update).toHaveBeenCalledTimes(1);
      expect(updateWhere).toHaveBeenCalled();
      expect(vi.mocked(ne)).toHaveBeenCalledWith(expect.anything(), 'resolved');
    });

    it('flags self when the only overlapping unit is resolved', async () => {
      const { ne, inArray } = await import('drizzle-orm');
      const self = {
        id: 10,
        bibleTextId: 200,
        bookId: 40,
        chapterNumber: 1,
        verseNumber: 1,
        conflictStatus: 'clean',
        granularity: 'verse',
        startChapter: null,
        startVerse: null,
        endChapter: null,
        endVerse: null,
      };
      const resolvedOverlap = {
        id: 11,
        bibleTextId: 201,
        bookId: 40,
        chapterNumber: 1,
        verseNumber: 2,
        conflictStatus: 'resolved',
        granularity: 'verse',
        startChapter: null,
        startVerse: null,
        endChapter: null,
        endVerse: null,
      };

      const { tx, updateWhere } = mockLockedRows([self, resolvedOverlap]);

      const result = await repo.markIntersectingCoverageConflicts({
        projectUnitId: 12,
        selfBibleTextId: 200,
        bookId: 40,
        coverage,
      });

      // Contender B flagged; adjudicated A stays out of toMark (and UPDATE ne-guards resolved).
      expect(result).toEqual(ok({ markedIds: [10] }));
      expect(tx.update).toHaveBeenCalledTimes(1);
      expect(updateWhere).toHaveBeenCalled();
      expect(vi.mocked(inArray)).toHaveBeenCalledWith(expect.anything(), [10]);
      expect(vi.mocked(ne)).toHaveBeenCalledWith(expect.anything(), 'resolved');
    });

    it('does not re-flag a resolved self even when overlaps exist', async () => {
      const self = {
        id: 20,
        bibleTextId: 300,
        bookId: 40,
        chapterNumber: 1,
        verseNumber: 1,
        conflictStatus: 'resolved',
        granularity: 'verse',
        startChapter: null,
        startVerse: null,
        endChapter: null,
        endVerse: null,
      };
      const cleanOverlap = {
        id: 21,
        bibleTextId: 301,
        bookId: 40,
        chapterNumber: 1,
        verseNumber: 3,
        conflictStatus: 'clean',
        granularity: 'verse',
        startChapter: null,
        startVerse: null,
        endChapter: null,
        endVerse: null,
      };

      const { tx } = mockLockedRows([self, cleanOverlap]);

      const result = await repo.markIntersectingCoverageConflicts({
        projectUnitId: 12,
        selfBibleTextId: 300,
        bookId: 40,
        coverage,
      });

      // Overlap still marks the non-resolved peer; resolved self stays resolved.
      expect(result).toEqual(ok({ markedIds: [21] }));
      expect(tx.update).toHaveBeenCalledTimes(1);
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
      vi.mocked(db.update).mockReturnValue({ set } as never);

      const resolvedRecord = { ...mockRecord, conflictStatus: 'resolved' };
      mockSelect(resolvedRecord);

      const result = await repo.markConflictPreservingActive(1);

      expect(result).toEqual({ ok: true, data: resolvedRecord });
    });

    it('returns 404 when recording does not exist', async () => {
      const returning = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      vi.mocked(db.update).mockReturnValue({ set } as never);

      mockSelect(null);

      const result = await repo.markConflictPreservingActive(1);

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
    });
  });
});
