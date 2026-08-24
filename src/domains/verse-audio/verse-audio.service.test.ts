import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  audioBlobName,
  deleteVerseAudio,
  generateAudioDownloadUrl,
  uploadVerseAudio,
} from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';

import type { VerseAudioRecord, VerseAudioTakeRecord } from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import * as repo from './verse-audio.repository';
import {
  deleteRecording,
  getRecording,
  listChapterRecordings,
  reclaimOrphanedStorageObjects,
  resolveConflict,
  uploadRecording,
} from './verse-audio.service';
import { VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

vi.mock('@/lib/audio-storage', () => ({
  audioBlobName: vi.fn(
    (unitId: number, textId: number, hash: string) => `unit-${unitId}/text-${textId}/${hash}`
  ),
  audioBucket: vi.fn(() => 'verse-audio'),
  uploadVerseAudio: vi.fn(async () => {}),
  deleteVerseAudio: vi.fn(async () => {}),
  generateAudioDownloadUrl: vi.fn(async (key: string) => `https://r2.example/${key}?sig=x`),
}));

vi.mock('./storage-objects.repository', () => ({
  claim: vi.fn(),
  getById: vi.fn(),
  markDeleted: vi.fn(),
  findOrphans: vi.fn(),
}));

vi.mock('./verse-audio.repository', () => ({
  get: vi.fn(),
  listByChapter: vi.fn(),
  listTakesByRecordingIds: vi.fn(),
  listTakesForRecording: vi.fn(),
  findTakeByContentHash: vi.fn(),
  getTakeById: vi.fn(),
  insertTake: vi.fn(),
  upsert: vi.fn(),
  updateRecordingState: vi.fn(),
  remove: vi.fn(),
  chapterHasConflict: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const hashOf = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const record: VerseAudioRecord = {
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

const take: VerseAudioTakeRecord = {
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

const uploadInput = {
  projectUnitId: 12,
  bibleTextId: 3401,
  uploadedBy: 7,
  contentType: 'audio/mp4',
  data: Buffer.from('abcd'),
  durationSeconds: 12.5,
};

describe('verse-audio service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageRepo.claim).mockResolvedValue(
      ok({
        id: 55,
        bucket: 'verse-audio',
        key: `unit-12/text-3401/${take.contentHash}`,
        createdAt: new Date(),
        deletedAt: null,
      })
    );
    vi.mocked(storageRepo.getById).mockResolvedValue(
      ok({
        id: 55,
        bucket: 'verse-audio',
        key: `unit-12/text-3401/${take.contentHash}`,
        createdAt: new Date(),
        deletedAt: null,
      })
    );
    vi.mocked(storageRepo.markDeleted).mockResolvedValue(ok(undefined));
    vi.mocked(uploadVerseAudio).mockResolvedValue(undefined);
    vi.mocked(deleteVerseAudio).mockResolvedValue(undefined);
    vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take]));
    vi.mocked(repo.listTakesByRecordingIds).mockResolvedValue(ok([take]));
  });

  describe('uploadRecording', () => {
    it('creates the first take cleanly when no unit exists', async () => {
      vi.mocked(repo.get)
        .mockResolvedValueOnce(err(ErrorCode.VERSE_AUDIO_NOT_FOUND))
        .mockResolvedValue(ok({ ...record, activeTakeId: 10 }));
      vi.mocked(repo.upsert).mockResolvedValue(ok({ ...record, activeTakeId: null }));
      vi.mocked(repo.insertTake).mockResolvedValue(ok(take));
      vi.mocked(repo.updateRecordingState).mockResolvedValue(ok(record));

      const result = await uploadRecording(uploadInput);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.versionToken).toBe(1);
        expect(result.data.conflictStatus).toBe('clean');
        expect(result.data.takes).toHaveLength(1);
      }
      expect(repo.upsert).toHaveBeenCalled();
      expect(repo.insertTake).toHaveBeenCalledWith(
        expect.objectContaining({ contentHash: take.contentHash })
      );
    });

    it('rejects unsupported content types without touching storage', async () => {
      const result = await uploadRecording({ ...uploadInput, contentType: 'video/mp4' });

      expect(result).toEqual(err(ErrorCode.UNSUPPORTED_AUDIO_TYPE));
      expect(uploadVerseAudio).not.toHaveBeenCalled();
    });

    it('rejects empty files without touching storage', async () => {
      const result = await uploadRecording({ ...uploadInput, data: Buffer.alloc(0) });

      expect(result).toEqual(err(ErrorCode.EMPTY_AUDIO_FILE));
      expect(uploadVerseAudio).not.toHaveBeenCalled();
    });

    it('suppresses false conflicts when content hash already exists', async () => {
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(take));

      const result = await uploadRecording({ ...uploadInput, baseVersionToken: 0 });

      expect(result.ok).toBe(true);
      expect(repo.insertTake).not.toHaveBeenCalled();
      expect(uploadVerseAudio).not.toHaveBeenCalled();
    });

    it('updates cleanly when baseVersionToken matches', async () => {
      const newData = Buffer.from('efgh');
      const newHash = hashOf(newData);
      const newTake = { ...take, id: 11, contentHash: newHash, storageObjectId: 56 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(record))
        .mockResolvedValue(ok({ ...record, versionToken: 2, activeTakeId: 11 }));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(null));
      vi.mocked(storageRepo.claim).mockResolvedValue(
        ok({
          id: 56,
          bucket: 'verse-audio',
          key: `unit-12/text-3401/${newHash}`,
          createdAt: new Date(),
          deletedAt: null,
        })
      );
      vi.mocked(repo.insertTake).mockResolvedValue(ok(newTake));
      vi.mocked(repo.updateRecordingState).mockResolvedValue(
        ok({
          ...record,
          versionToken: 2,
          activeTakeId: 11,
          storageObjectId: 56,
          sizeBytes: 4,
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

      const result = await uploadRecording({
        ...uploadInput,
        data: newData,
        baseVersionToken: 1,
      });

      expect(repo.updateRecordingState).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          versionToken: 2,
          conflictStatus: 'clean',
          activeTakeId: 11,
        })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('clean');
        expect(result.data.versionToken).toBe(2);
      }
    });

    it('marks conflict when baseVersionToken is stale', async () => {
      const newData = Buffer.from('conflict');
      const newHash = hashOf(newData);
      const conflictTake = { ...take, id: 11, contentHash: newHash, uploadedBy: 9 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(record))
        .mockResolvedValue(
          ok({
            ...record,
            versionToken: 2,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
          })
        );
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(null));
      vi.mocked(storageRepo.claim).mockResolvedValue(
        ok({
          id: 56,
          bucket: 'verse-audio',
          key: `unit-12/text-3401/${newHash}`,
          createdAt: new Date(),
          deletedAt: null,
        })
      );
      vi.mocked(repo.insertTake).mockResolvedValue(ok(conflictTake));
      vi.mocked(repo.updateRecordingState).mockResolvedValue(
        ok({
          ...record,
          versionToken: 2,
          conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, conflictTake]));

      const result = await uploadRecording({
        ...uploadInput,
        data: newData,
        uploadedBy: 9,
        baseVersionToken: 0,
      });

      expect(repo.updateRecordingState).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          versionToken: 2,
          conflictStatus: 'conflict',
        })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
        expect(result.data.takes).toHaveLength(2);
        expect(result.data.activeTakeId).toBe(10);
      }
    });

    it('returns INTERNAL_ERROR and skips the DB when the blob upload throws', async () => {
      vi.mocked(repo.get).mockResolvedValue(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
      vi.mocked(uploadVerseAudio).mockRejectedValue(new Error('r2 down'));

      const result = await uploadRecording(uploadInput);

      expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
      expect(repo.upsert).not.toHaveBeenCalled();
    });
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
        id: 2,
        bibleTextId: 3402,
        verseNumber: 4,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      };
      vi.mocked(repo.listByChapter).mockResolvedValue(ok([record, conflicted]));
      vi.mocked(repo.listTakesByRecordingIds).mockResolvedValue(
        ok([take, { ...take, id: 20, recordingId: 2 }])
      );

      const result = await listChapterRecordings(12, 1, 3);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items).toHaveLength(2);
        expect(result.data.hasConflict).toBe(true);
      }
    });
  });

  describe('resolveConflict', () => {
    it('sets the chosen take active and clears conflict', async () => {
      const other = { ...take, id: 11, uploadedBy: 9, contentHash: 'other' };
      vi.mocked(repo.get)
        .mockResolvedValueOnce(
          ok({ ...record, conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT })
        )
        .mockResolvedValue(
          ok({
            ...record,
            versionToken: 2,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
            activeTakeId: 11,
          })
        );
      vi.mocked(repo.getTakeById).mockResolvedValue(ok(other));
      vi.mocked(repo.updateRecordingState).mockResolvedValue(
        ok({
          ...record,
          versionToken: 2,
          conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
          activeTakeId: 11,
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, other]));

      const result = await resolveConflict({
        projectUnitId: 12,
        bibleTextId: 3401,
        takeId: 11,
      });

      expect(repo.updateRecordingState).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          activeTakeId: 11,
          conflictStatus: 'clean',
          versionToken: 2,
        })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('clean');
        expect(result.data.activeTakeId).toBe(11);
      }
    });

    it('rejects takes that do not belong to the unit', async () => {
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(repo.getTakeById).mockResolvedValue(ok({ ...take, recordingId: 999 }));

      const result = await resolveConflict({
        projectUnitId: 12,
        bibleTextId: 3401,
        takeId: 10,
      });

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND));
    });
  });

  describe('deleteRecording', () => {
    it('removes the row then each take object', async () => {
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(repo.remove).mockResolvedValue(ok(undefined));

      const result = await deleteRecording(12, 3401);

      expect(repo.remove).toHaveBeenCalledWith(12, 3401);
      expect(deleteVerseAudio).toHaveBeenCalled();
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

  describe('storage object tracking', () => {
    it('claims the storage row before writing the object on first upload', async () => {
      const order: string[] = [];
      vi.mocked(repo.get)
        .mockResolvedValueOnce(err(ErrorCode.VERSE_AUDIO_NOT_FOUND))
        .mockResolvedValue(ok(record));
      vi.mocked(storageRepo.claim).mockImplementation(async () => {
        order.push('claim');
        return ok({
          id: 55,
          bucket: 'verse-audio',
          key: `unit-12/text-3401/${take.contentHash}`,
          createdAt: new Date(),
          deletedAt: null,
        });
      });
      vi.mocked(uploadVerseAudio).mockImplementation(async () => {
        order.push('upload');
      });
      vi.mocked(repo.upsert).mockResolvedValue(ok({ ...record, activeTakeId: null }));
      vi.mocked(repo.insertTake).mockResolvedValue(ok(take));
      vi.mocked(repo.updateRecordingState).mockResolvedValue(ok(record));

      await uploadRecording(uploadInput);

      expect(order).toEqual(['claim', 'upload']);
      expect(storageRepo.claim).toHaveBeenCalledWith(
        'verse-audio',
        `unit-12/text-3401/${take.contentHash}`
      );
      expect(audioBlobName).toHaveBeenCalledWith(12, 3401, take.contentHash);
    });
  });

  describe('reclaimOrphanedStorageObjects', () => {
    const orphan = (id: number, key: string) => ({
      id,
      key,
      bucket: 'verse-audio',
      createdAt: new Date(),
      deletedAt: null,
    });

    it('deletes each orphaned object and stamps its row', async () => {
      vi.mocked(storageRepo.findOrphans).mockResolvedValue(
        ok([orphan(1, 'unit-9/text-1/a'), orphan(2, 'unit-9/text-2/b')])
      );

      const result = await reclaimOrphanedStorageObjects();

      expect(storageRepo.findOrphans).toHaveBeenCalledWith(expect.any(Number));
      expect(deleteVerseAudio).toHaveBeenCalledTimes(2);
      expect(storageRepo.markDeleted).toHaveBeenCalledWith(1);
      expect(storageRepo.markDeleted).toHaveBeenCalledWith(2);
      expect(result).toEqual(ok(2));
    });
  });
});
