import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteVerseAudio, generateAudioDownloadUrl } from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';

import type { VerseAudioTakeRecord } from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import * as repo from './verse-audio.repository';
import {
  deleteRecording,
  getRecording,
  listChapterRecordings,
  resolveConflict,
} from './verse-audio.service';
import { record, take } from './verse-audio.test-fixtures';
import { VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

vi.mock('@/lib/audio-storage', () => ({
  audioBlobName: vi.fn(
    (unitId: number, textId: number, hash: string) => `unit-${unitId}/text-${textId}/${hash}`
  ),
  audioBucket: vi.fn(() => 'verse-audio'),
  deleteVerseAudio: vi.fn(async () => {}),
  generateAudioDownloadUrl: vi.fn(async (key: string) => `https://r2.example/${key}?sig=x`),
  uploadVerseAudio: vi.fn(async () => {}),
}));

vi.mock('./storage-objects.repository', () => ({
  claim: vi.fn(),
  findOrphans: vi.fn(),
  getById: vi.fn(),
  getByIds: vi.fn(),
  markDeleted: vi.fn(),
  reclaimOrphanIfUnreferenced: vi.fn(),
}));

vi.mock('./verse-audio.repository', () => ({
  createFirstRecordingWithTake: vi.fn(),
  findTakeByContentHash: vi.fn(),
  get: vi.fn(),
  getTakeById: vi.fn(),
  insertTake: vi.fn(),
  listByChapter: vi.fn(),
  listTakesByRecordingIds: vi.fn(),
  listTakesForRecording: vi.fn(),
  markConflictPreservingActive: vi.fn(),
  pruneSupersededTakes: vi.fn(),
  remove: vi.fn(),
  updateRecordingStateIfVersion: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

describe('verse-audio service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageRepo.getById).mockResolvedValue(
      ok({
        bucket: 'verse-audio',
        createdAt: new Date(),
        deletedAt: null,
        id: 55,
        key: `unit-12/text-3401/${take.contentHash}`,
      })
    );
    vi.mocked(storageRepo.getByIds).mockResolvedValue(ok([]));
    vi.mocked(deleteVerseAudio).mockResolvedValue(undefined);
    vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take]));
    vi.mocked(repo.listTakesByRecordingIds).mockResolvedValue(ok([take]));
  });

  describe('getRecording', () => {
    it('attaches takes and download URLs', async () => {
      vi.mocked(repo.get).mockResolvedValue(ok(record));

      const result = await getRecording(12, 3401);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.takes).toHaveLength(1);
        expect(result.data.downloadUrl).toContain('https://r2.example/');
        expect(result.data.versionToken).toBe(1);
      }
      // Hash-keyed objects derive the blob name — no storage_objects round trip.
      expect(storageRepo.getByIds).not.toHaveBeenCalled();
      expect(storageRepo.getById).not.toHaveBeenCalled();
      expect(generateAudioDownloadUrl).toHaveBeenCalledWith(
        `unit-12/text-3401/${take.contentHash}`
      );
    });

    it('looks up legacy storage keys in one batch when contentHash is a placeholder', async () => {
      const legacyTake: VerseAudioTakeRecord = {
        ...take,
        contentHash: 'legacy-1',
      };
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([legacyTake]));
      vi.mocked(storageRepo.getByIds).mockResolvedValue(
        ok([
          {
            bucket: 'verse-audio',
            createdAt: new Date(),
            deletedAt: null,
            id: 55,
            key: 'unit-12/text-3401',
          },
        ])
      );

      const result = await getRecording(12, 3401);

      expect(storageRepo.getByIds).toHaveBeenCalledTimes(1);
      expect(storageRepo.getByIds).toHaveBeenCalledWith([55]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.downloadUrl).toBe('https://r2.example/unit-12/text-3401?sig=x');
        expect(result.data.takes[0]?.downloadUrl).toBe(
          'https://r2.example/unit-12/text-3401?sig=x'
        );
      }
    });

    it('propagates not-found from the repository', async () => {
      vi.mocked(repo.get).mockResolvedValue(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));

      const result = await getRecording(12, 3401);

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
      expect(generateAudioDownloadUrl).not.toHaveBeenCalled();
    });
  });

  describe('listChapterRecordings', () => {
    it('returns items and hasConflict rollup', async () => {
      const conflicted = {
        ...record,
        bibleTextId: 3402,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
        id: 2,
        verseNumber: 4,
      };
      vi.mocked(repo.listByChapter).mockResolvedValue(ok([record, conflicted]));
      vi.mocked(repo.listTakesByRecordingIds).mockResolvedValue(
        ok([take, { ...take, id: 20, recordingId: 2 }])
      );

      const result = await listChapterRecordings(12, 9, 1, 3);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items).toHaveLength(2);
        expect(result.data.hasConflict).toBe(true);
      }
      expect(repo.listByChapter).toHaveBeenCalledWith(12, 9, 1, 3);
      expect(storageRepo.getByIds).not.toHaveBeenCalled();
    });

    it('excludes resolved recordings from hasConflict rollup', async () => {
      const resolved = {
        ...record,
        bibleTextId: 3402,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.RESOLVED,
        id: 2,
        verseNumber: 4,
      };
      vi.mocked(repo.listByChapter).mockResolvedValue(ok([record, resolved]));
      vi.mocked(repo.listTakesByRecordingIds).mockResolvedValue(
        ok([take, { ...take, id: 20, recordingId: 2 }])
      );

      const result = await listChapterRecordings(12, 9, 1, 3);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items).toHaveLength(2);
        expect(result.data.hasConflict).toBe(false);
      }
    });

    it('batches a single getByIds for legacy takes across the chapter', async () => {
      const legacyA = { ...record, storageObjectId: 55 };
      const legacyB = {
        ...record,
        activeTakeId: 20,
        bibleTextId: 3402,
        id: 2,
        storageObjectId: 66,
        verseNumber: 4,
      };
      const takeA: VerseAudioTakeRecord = { ...take, contentHash: 'legacy-1', storageObjectId: 55 };
      const takeB: VerseAudioTakeRecord = {
        ...take,
        contentHash: 'legacy-2',
        id: 20,
        recordingId: 2,
        storageObjectId: 66,
      };
      vi.mocked(repo.listByChapter).mockResolvedValue(ok([legacyA, legacyB]));
      vi.mocked(repo.listTakesByRecordingIds).mockResolvedValue(ok([takeA, takeB]));
      vi.mocked(storageRepo.getByIds).mockResolvedValue(
        ok([
          {
            bucket: 'verse-audio',
            createdAt: new Date(),
            deletedAt: null,
            id: 55,
            key: 'unit-12/text-3401',
          },
          {
            bucket: 'verse-audio',
            createdAt: new Date(),
            deletedAt: null,
            id: 66,
            key: 'unit-12/text-3402',
          },
        ])
      );

      const result = await listChapterRecordings(12, 9, 1, 3);

      expect(storageRepo.getByIds).toHaveBeenCalledTimes(1);
      expect(storageRepo.getByIds).toHaveBeenCalledWith([55, 66]);
      expect(storageRepo.getById).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items[0]?.downloadUrl).toBe(
          'https://r2.example/unit-12/text-3401?sig=x'
        );
        expect(result.data.items[1]?.downloadUrl).toBe(
          'https://r2.example/unit-12/text-3402?sig=x'
        );
      }
    });
  });

  describe('resolveConflict', () => {
    it('sets the chosen take active and marks the conflict resolved', async () => {
      const other = { ...take, contentHash: 'other', id: 11, uploadedBy: 9 };
      vi.mocked(repo.get)
        .mockResolvedValueOnce(
          ok({ ...record, conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT })
        )
        .mockResolvedValue(
          ok({
            ...record,
            activeTakeId: 11,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.RESOLVED,
            versionToken: 2,
          })
        );
      vi.mocked(repo.getTakeById).mockResolvedValue(ok(other));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: {
            ...record,
            activeTakeId: 11,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.RESOLVED,
            versionToken: 2,
          },
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, other]));

      const result = await resolveConflict({
        bibleTextId: 3401,
        projectUnitId: 12,
        takeId: 11,
      });

      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
        1,
        expect.objectContaining({
          activeTakeId: 11,
          conflictStatus: 'resolved',
          storageObjectId: other.storageObjectId,
          versionToken: 2,
        })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('resolved');
        expect(result.data.activeTakeId).toBe(11);
      }
    });

    it('returns CONFLICT when a concurrent writer advances the version token', async () => {
      vi.mocked(repo.get).mockResolvedValue(
        ok({ ...record, conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT })
      );
      vi.mocked(repo.getTakeById).mockResolvedValue(ok(take));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({ applied: false, record: null })
      );

      const result = await resolveConflict({
        bibleTextId: 3401,
        projectUnitId: 12,
        takeId: 10,
      });

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT));
    });

    it('rejects takes that do not belong to the unit', async () => {
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(repo.getTakeById).mockResolvedValue(ok({ ...take, recordingId: 999 }));

      const result = await resolveConflict({
        bibleTextId: 3401,
        projectUnitId: 12,
        takeId: 10,
      });

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND));
    });

    it('rejects resolve when the unit is clean (never conflicted)', async () => {
      vi.mocked(repo.get).mockResolvedValue(
        ok({ ...record, conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN })
      );
      vi.mocked(repo.getTakeById).mockResolvedValue(ok(take));

      const result = await resolveConflict({
        bibleTextId: 3401,
        projectUnitId: 12,
        takeId: 10,
      });

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_IN_CONFLICT));
      expect(repo.updateRecordingStateIfVersion).not.toHaveBeenCalled();
    });

    it('rejects resolve when the unit is already resolved', async () => {
      vi.mocked(repo.get).mockResolvedValue(
        ok({ ...record, conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.RESOLVED })
      );
      vi.mocked(repo.getTakeById).mockResolvedValue(ok(take));

      const result = await resolveConflict({
        bibleTextId: 3401,
        projectUnitId: 12,
        takeId: 10,
      });

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_IN_CONFLICT));
      expect(repo.updateRecordingStateIfVersion).not.toHaveBeenCalled();
    });
  });

  describe('deleteRecording', () => {
    it('removes the row then each take object', async () => {
      const secondTake: VerseAudioTakeRecord = {
        ...take,
        contentHash: 'second-hash',
        id: 11,
        storageObjectId: 56,
      };
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, secondTake]));
      vi.mocked(repo.remove).mockResolvedValue(ok(undefined));
      vi.mocked(storageRepo.getById)
        .mockResolvedValueOnce(
          ok({
            bucket: 'verse-audio',
            createdAt: new Date(),
            deletedAt: null,
            id: 55,
            key: `unit-12/text-3401/${take.contentHash}`,
          })
        )
        .mockResolvedValueOnce(
          ok({
            bucket: 'verse-audio',
            createdAt: new Date(),
            deletedAt: null,
            id: 56,
            key: 'unit-12/text-3401/second-hash',
          })
        );

      const result = await deleteRecording(12, 3401);

      expect(repo.remove).toHaveBeenCalledWith(12, 3401);
      expect(deleteVerseAudio).toHaveBeenCalledTimes(2);
      expect(deleteVerseAudio).toHaveBeenNthCalledWith(1, `unit-12/text-3401/${take.contentHash}`);
      expect(deleteVerseAudio).toHaveBeenNthCalledWith(2, 'unit-12/text-3401/second-hash');
      expect(result).toEqual(ok(undefined));
    });

    it('returns not-found without touching the blob when no recording exists', async () => {
      vi.mocked(repo.get).mockResolvedValue(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));

      const result = await deleteRecording(12, 3401);

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
      expect(deleteVerseAudio).not.toHaveBeenCalled();
      expect(repo.remove).not.toHaveBeenCalled();
    });
  });
});
