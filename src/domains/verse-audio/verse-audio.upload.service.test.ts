import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { audioBlobName, uploadVerseAudio } from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import * as repo from './verse-audio.repository';
import { uploadRecording } from './verse-audio.service';
import { hashOf, record, take, uploadInput } from './verse-audio.test-fixtures';

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
  get: vi.fn(),
  updateRecordingStateIfVersion: vi.fn(),
}));

vi.mock('./verse-audio-takes.repository', () => ({
  findTakeByContentHash: vi.fn(),
  insertTake: vi.fn(),
  listTakesByRecordingIds: vi.fn(),
  listTakesForRecording: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

describe('verse-audio service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageRepo.claim).mockResolvedValue(
      ok({
        bucket: 'verse-audio',
        createdAt: new Date(),
        deletedAt: null,
        id: 55,
        key: `unit-12/text-3401/${take.contentHash}`,
      })
    );
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
    vi.mocked(storageRepo.markDeleted).mockResolvedValue(ok(undefined));
    vi.mocked(uploadVerseAudio).mockResolvedValue(undefined);
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take]));
    vi.mocked(takesRepo.listTakesByRecordingIds).mockResolvedValue(ok([take]));
  });

  describe('uploadRecording', () => {
    it('creates the first take cleanly when no unit exists', async () => {
      vi.mocked(repo.get)
        .mockResolvedValueOnce(err(ErrorCode.VERSE_AUDIO_NOT_FOUND))
        .mockResolvedValue(ok({ ...record, activeTakeId: 10, versionToken: 2 }));
      vi.mocked(repo.createFirstRecordingWithTake).mockResolvedValue(
        ok({
          outcome: 'created',
          record: { ...record, activeTakeId: 10, versionToken: 2 },
          take,
        })
      );

      const result = await uploadRecording(uploadInput);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.versionToken).toBe(2);
        expect(result.data.conflictStatus).toBe('clean');
        expect(result.data.takes).toHaveLength(1);
      }
      expect(repo.createFirstRecordingWithTake).toHaveBeenCalledWith(
        expect.objectContaining({
          activeTakeId: null,
          bibleTextId: 3401,
          conflictStatus: 'clean',
          contentType: 'audio/mp4',
          durationSeconds: 12.5,
          projectUnitId: 12,
          sizeBytes: 4,
          storageObjectId: 55,
          uploadedBy: 7,
          versionToken: 1,
        }),
        expect.objectContaining({
          contentHash: take.contentHash,
          contentType: 'audio/mp4',
          durationSeconds: 12.5,
          sizeBytes: 4,
          storageObjectId: 55,
          uploadedBy: 7,
        })
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

    it('promotes an existing non-active take when base is fresh (intentional revert)', async () => {
      const prior = { ...take, id: 10 };
      const active = {
        ...take,
        contentHash: hashOf(Buffer.from('newer')),
        id: 11,
        storageObjectId: 56,
      };
      const unit = { ...record, activeTakeId: 11, storageObjectId: 56, versionToken: 3 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(unit))
        .mockResolvedValue(ok({ ...unit, activeTakeId: 10, storageObjectId: 55, versionToken: 4 }));
      vi.mocked(takesRepo.findTakeByContentHash).mockResolvedValue(ok(prior));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: { ...unit, activeTakeId: 10, storageObjectId: 55, versionToken: 4 },
        })
      );
      vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([prior, active]));

      const result = await uploadRecording({
        ...uploadInput,
        baseVersionToken: 3,
        data: Buffer.from('abcd'),
      });

      expect(takesRepo.insertTake).not.toHaveBeenCalled();
      expect(uploadVerseAudio).not.toHaveBeenCalled();
      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
        3,
        expect.objectContaining({
          activeTakeId: 10,
          versionToken: 4,
        })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.activeTakeId).toBe(10);
      }
    });

    it('logs when a legacy client omits baseVersionToken', async () => {
      const { logger } = await import('@/lib/logger');
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(takesRepo.findTakeByContentHash).mockResolvedValue(ok(take));

      await uploadRecording(uploadInput);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'verse_audio_upload_legacy_no_token' }),
        expect.stringContaining('legacy replace')
      );
    });

    it('replaces cleanly when baseVersionToken is omitted (legacy clients)', async () => {
      const newData = Buffer.from('legacy-replace');
      const newHash = hashOf(newData);
      const newTake = { ...take, contentHash: newHash, id: 11, storageObjectId: 56 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(record))
        .mockResolvedValue(ok({ ...record, activeTakeId: 11, versionToken: 2 }));
      vi.mocked(takesRepo.findTakeByContentHash).mockResolvedValue(ok(null));
      vi.mocked(storageRepo.claim).mockResolvedValue(
        ok({
          bucket: 'verse-audio',
          createdAt: new Date(),
          deletedAt: null,
          id: 56,
          key: `unit-12/text-3401/${newHash}`,
        })
      );
      vi.mocked(takesRepo.insertTake).mockResolvedValue(ok(newTake));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: {
            ...record,
            activeTakeId: 11,
            sizeBytes: newData.length,
            storageObjectId: 56,
            versionToken: 2,
          },
        })
      );
      vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

      const result = await uploadRecording({
        ...uploadInput,
        data: newData,
      });

      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
        1,
        expect.objectContaining({
          activeTakeId: 11,
          versionToken: 2,
        })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('clean');
      }
    });

    it('updates cleanly when baseVersionToken matches', async () => {
      const newData = Buffer.from('efgh');
      const newHash = hashOf(newData);
      const newTake = { ...take, contentHash: newHash, id: 11, storageObjectId: 56 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(record))
        .mockResolvedValue(ok({ ...record, activeTakeId: 11, versionToken: 2 }));
      vi.mocked(takesRepo.findTakeByContentHash).mockResolvedValue(ok(null));
      vi.mocked(storageRepo.claim).mockResolvedValue(
        ok({
          bucket: 'verse-audio',
          createdAt: new Date(),
          deletedAt: null,
          id: 56,
          key: `unit-12/text-3401/${newHash}`,
        })
      );
      vi.mocked(takesRepo.insertTake).mockResolvedValue(ok(newTake));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: {
            ...record,
            activeTakeId: 11,
            sizeBytes: 4,
            storageObjectId: 56,
            versionToken: 2,
          },
        })
      );
      vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

      const result = await uploadRecording({
        ...uploadInput,
        baseVersionToken: 1,
        data: newData,
      });

      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
        1,
        expect.objectContaining({
          activeTakeId: 11,
          versionToken: 2,
        })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('clean');
        expect(result.data.versionToken).toBe(2);
      }
    });

    it('returns INTERNAL_ERROR and skips the DB when the blob upload throws', async () => {
      vi.mocked(repo.get).mockResolvedValue(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
      vi.mocked(uploadVerseAudio).mockRejectedValue(new Error('r2 down'));

      const result = await uploadRecording(uploadInput);

      expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
      expect(repo.createFirstRecordingWithTake).not.toHaveBeenCalled();
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
          bucket: 'verse-audio',
          createdAt: new Date(),
          deletedAt: null,
          id: 55,
          key: `unit-12/text-3401/${take.contentHash}`,
        });
      });
      vi.mocked(uploadVerseAudio).mockImplementation(async () => {
        order.push('upload');
      });
      vi.mocked(repo.createFirstRecordingWithTake).mockResolvedValue(
        ok({ outcome: 'created', record, take })
      );

      await uploadRecording(uploadInput);

      expect(order).toEqual(['claim', 'upload']);
      expect(storageRepo.claim).toHaveBeenCalledWith(
        'verse-audio',
        `unit-12/text-3401/${take.contentHash}`
      );
      expect(audioBlobName).toHaveBeenCalledWith(12, 3401, take.contentHash);
    });
  });
});
