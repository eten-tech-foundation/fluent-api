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
  getByIds: vi.fn(),
  markDeleted: vi.fn(),
  findOrphans: vi.fn(),
  reclaimOrphanIfUnreferenced: vi.fn(),
}));

vi.mock('./verse-audio.repository', () => ({
  get: vi.fn(),
  listByChapter: vi.fn(),
  listTakesByRecordingIds: vi.fn(),
  listTakesForRecording: vi.fn(),
  findTakeByContentHash: vi.fn(),
  getTakeById: vi.fn(),
  insertTake: vi.fn(),
  insertRecording: vi.fn(),
  updateRecordingState: vi.fn(),
  updateRecordingStateIfVersion: vi.fn(),
  markConflictPreservingActive: vi.fn(),
  remove: vi.fn(),
  pruneSupersededTakes: vi.fn(),
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
    vi.mocked(storageRepo.getByIds).mockResolvedValue(ok([]));
    vi.mocked(storageRepo.markDeleted).mockResolvedValue(ok(undefined));
    vi.mocked(storageRepo.reclaimOrphanIfUnreferenced).mockResolvedValue(ok(false));
    vi.mocked(uploadVerseAudio).mockResolvedValue(undefined);
    vi.mocked(deleteVerseAudio).mockResolvedValue(undefined);
    vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take]));
    vi.mocked(repo.listTakesByRecordingIds).mockResolvedValue(ok([take]));
    vi.mocked(repo.pruneSupersededTakes).mockResolvedValue(ok(0));
  });

  describe('uploadRecording', () => {
    it('creates the first take cleanly when no unit exists', async () => {
      vi.mocked(repo.get)
        .mockResolvedValueOnce(err(ErrorCode.VERSE_AUDIO_NOT_FOUND))
        .mockResolvedValue(ok({ ...record, activeTakeId: 10 }));
      vi.mocked(repo.insertRecording).mockResolvedValue(ok({ ...record, activeTakeId: null }));
      vi.mocked(repo.insertTake).mockResolvedValue(ok(take));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({ applied: true, record })
      );

      const result = await uploadRecording(uploadInput);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.versionToken).toBe(1);
        expect(result.data.conflictStatus).toBe('clean');
        expect(result.data.takes).toHaveLength(1);
      }
      expect(repo.insertRecording).toHaveBeenCalled();
      expect(repo.insertTake).toHaveBeenCalledWith(
        expect.objectContaining({ contentHash: take.contentHash })
      );
      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
        1,
        expect.objectContaining({ activeTakeId: 10, versionToken: 2 }),
        { requireNullActiveTake: true }
      );
    });

    it('does not flag conflict when a concurrent first upload reloads the same active take', async () => {
      vi.mocked(repo.get)
        .mockResolvedValueOnce(err(ErrorCode.VERSE_AUDIO_NOT_FOUND))
        .mockResolvedValue(ok(record));
      // Race loser reloads the winner's already-linked unit.
      vi.mocked(repo.insertRecording).mockResolvedValue(ok(record));
      vi.mocked(repo.insertTake).mockResolvedValue(ok(take));

      const result = await uploadRecording(uploadInput);

      expect(result.ok).toBe(true);
      expect(repo.markConflictPreservingActive).not.toHaveBeenCalled();
      expect(repo.updateRecordingStateIfVersion).not.toHaveBeenCalled();
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

    it('suppresses false conflicts when content hash already exists on the active take', async () => {
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(take));

      const result = await uploadRecording({ ...uploadInput, baseVersionToken: 2 });

      expect(result.ok).toBe(true);
      expect(repo.insertTake).not.toHaveBeenCalled();
      expect(uploadVerseAudio).not.toHaveBeenCalled();
      expect(repo.updateRecordingStateIfVersion).not.toHaveBeenCalled();
    });

    it('promotes an existing non-active take when base is fresh (intentional revert)', async () => {
      const prior = { ...take, id: 10 };
      const active = {
        ...take,
        id: 11,
        contentHash: hashOf(Buffer.from('newer')),
        storageObjectId: 56,
      };
      const unit = { ...record, versionToken: 3, activeTakeId: 11, storageObjectId: 56 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(unit))
        .mockResolvedValue(ok({ ...unit, versionToken: 4, activeTakeId: 10, storageObjectId: 55 }));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(prior));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: { ...unit, versionToken: 4, activeTakeId: 10, storageObjectId: 55 },
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([prior, active]));

      const result = await uploadRecording({
        ...uploadInput,
        data: Buffer.from('abcd'),
        baseVersionToken: 3,
      });

      expect(repo.insertTake).not.toHaveBeenCalled();
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

    it('preserves conflict when a legacy client replaces the active take', async () => {
      const conflicted = {
        ...record,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      };
      const newData = Buffer.from('legacy-over-conflict');
      const newHash = hashOf(newData);
      const newTake = { ...take, id: 11, contentHash: newHash, storageObjectId: 56 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(conflicted))
        .mockResolvedValue(
          ok({
            ...conflicted,
            versionToken: 2,
            activeTakeId: 11,
            storageObjectId: 56,
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
      vi.mocked(repo.insertTake).mockResolvedValue(ok(newTake));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: {
            ...conflicted,
            versionToken: 2,
            activeTakeId: 11,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
          },
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

      const result = await uploadRecording({
        ...uploadInput,
        data: newData,
      });

      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
        1,
        expect.objectContaining({
          versionToken: 2,
          activeTakeId: 11,
        })
      );
      expect(vi.mocked(repo.updateRecordingStateIfVersion).mock.calls[0]![2]).not.toHaveProperty(
        'conflictStatus'
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
        expect(result.data.activeTakeId).toBe(11);
      }
    });

    it('marks conflict when a stale base re-submits bytes for a non-active take', async () => {
      const prior = { ...take, id: 10 };
      const active = {
        ...take,
        id: 11,
        contentHash: hashOf(Buffer.from('newer')),
        storageObjectId: 56,
      };
      const unit = { ...record, versionToken: 3, activeTakeId: 11, storageObjectId: 56 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(unit))
        .mockResolvedValue(ok({ ...unit, conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT }));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(prior));
      vi.mocked(repo.markConflictPreservingActive).mockResolvedValue(
        ok({ ...unit, conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([prior, active]));

      const result = await uploadRecording({
        ...uploadInput,
        data: Buffer.from('abcd'),
        baseVersionToken: 1,
      });

      expect(repo.updateRecordingStateIfVersion).not.toHaveBeenCalled();
      expect(repo.markConflictPreservingActive).toHaveBeenCalledWith(1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
      }
    });

    it('does not let a losing client clear its own conflict by retrying the same bytes', async () => {
      // The stale-base response hands the loser the current token. Re-sending the
      // same bytes may promote its take, but must not settle the contest for it.
      const losing = { ...take, id: 10 };
      const active = { ...take, id: 11, contentHash: hashOf(Buffer.from('newer')) };
      const conflicted = {
        ...record,
        versionToken: 3,
        activeTakeId: 11,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(conflicted))
        .mockResolvedValue(ok({ ...conflicted, versionToken: 4, activeTakeId: 10 }));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(losing));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({ applied: true, record: { ...conflicted, versionToken: 4, activeTakeId: 10 } })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([losing, active]));

      const result = await uploadRecording({ ...uploadInput, baseVersionToken: 3 });

      expect(vi.mocked(repo.updateRecordingStateIfVersion).mock.calls[0]![2]).not.toHaveProperty(
        'conflictStatus'
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
      }
    });

    it('leaves an open conflict alone when a matching-token upload brings new bytes', async () => {
      const newData = Buffer.from('fresh-over-conflict');
      const newHash = hashOf(newData);
      const newTake = { ...take, id: 12, contentHash: newHash, storageObjectId: 56 };
      const conflicted = {
        ...record,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(conflicted))
        .mockResolvedValue(ok({ ...conflicted, versionToken: 2, activeTakeId: 12 }));
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
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({ applied: true, record: { ...conflicted, versionToken: 2, activeTakeId: 12 } })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

      const result = await uploadRecording({
        ...uploadInput,
        data: newData,
        baseVersionToken: 1,
      });

      expect(vi.mocked(repo.updateRecordingStateIfVersion).mock.calls[0]![2]).not.toHaveProperty(
        'conflictStatus'
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
      }
    });

    it('replaces cleanly when baseVersionToken is omitted (legacy clients)', async () => {
      const newData = Buffer.from('legacy-replace');
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
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: {
            ...record,
            versionToken: 2,
            activeTakeId: 11,
            storageObjectId: 56,
            sizeBytes: newData.length,
          },
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

      const result = await uploadRecording({
        ...uploadInput,
        data: newData,
      });

      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
        1,
        expect.objectContaining({
          versionToken: 2,
          activeTakeId: 11,
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
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: {
            ...record,
            versionToken: 2,
            activeTakeId: 11,
            storageObjectId: 56,
            sizeBytes: 4,
          },
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

      const result = await uploadRecording({
        ...uploadInput,
        data: newData,
        baseVersionToken: 1,
      });

      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
        1,
        expect.objectContaining({
          versionToken: 2,
          activeTakeId: 11,
        })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('clean');
        expect(result.data.versionToken).toBe(2);
      }
    });

    it('keeps a new take and marks conflict when the clean-update CAS loses', async () => {
      const newData = Buffer.from('concurrent');
      const newHash = hashOf(newData);
      const newTake = { ...take, id: 11, contentHash: newHash, storageObjectId: 56 };
      const conflicted = {
        ...record,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      };

      vi.mocked(repo.get).mockResolvedValueOnce(ok(record)).mockResolvedValue(ok(conflicted));
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
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({ applied: false, record: null })
      );
      vi.mocked(repo.markConflictPreservingActive).mockResolvedValue(ok(conflicted));
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

      const result = await uploadRecording({
        ...uploadInput,
        data: newData,
        baseVersionToken: 1,
      });

      expect(repo.insertTake).toHaveBeenCalledWith(
        expect.objectContaining({ contentHash: newHash })
      );
      expect(repo.markConflictPreservingActive).toHaveBeenCalledWith(record.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
        expect(result.data.takes).toHaveLength(2);
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
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: {
            ...record,
            versionToken: 2,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
          },
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, conflictTake]));

      const result = await uploadRecording({
        ...uploadInput,
        data: newData,
        uploadedBy: 9,
        baseVersionToken: 2,
      });

      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
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
      expect(repo.insertRecording).not.toHaveBeenCalled();
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
            id: 55,
            bucket: 'verse-audio',
            key: 'unit-12/text-3401',
            createdAt: new Date(),
            deletedAt: null,
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
      expect(storageRepo.getByIds).not.toHaveBeenCalled();
    });

    it('batches a single getByIds for legacy takes across the chapter', async () => {
      const legacyA = { ...record, storageObjectId: 55 };
      const legacyB = {
        ...record,
        id: 2,
        bibleTextId: 3402,
        verseNumber: 4,
        storageObjectId: 66,
        activeTakeId: 20,
      };
      const takeA: VerseAudioTakeRecord = { ...take, contentHash: 'legacy-1', storageObjectId: 55 };
      const takeB: VerseAudioTakeRecord = {
        ...take,
        id: 20,
        recordingId: 2,
        contentHash: 'legacy-2',
        storageObjectId: 66,
      };
      vi.mocked(repo.listByChapter).mockResolvedValue(ok([legacyA, legacyB]));
      vi.mocked(repo.listTakesByRecordingIds).mockResolvedValue(ok([takeA, takeB]));
      vi.mocked(storageRepo.getByIds).mockResolvedValue(
        ok([
          {
            id: 55,
            bucket: 'verse-audio',
            key: 'unit-12/text-3401',
            createdAt: new Date(),
            deletedAt: null,
          },
          {
            id: 66,
            bucket: 'verse-audio',
            key: 'unit-12/text-3402',
            createdAt: new Date(),
            deletedAt: null,
          },
        ])
      );

      const result = await listChapterRecordings(12, 1, 3);

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
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: {
            ...record,
            versionToken: 2,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
            activeTakeId: 11,
          },
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, other]));

      const result = await resolveConflict({
        projectUnitId: 12,
        bibleTextId: 3401,
        takeId: 11,
      });

      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
        1,
        expect.objectContaining({
          activeTakeId: 11,
          conflictStatus: 'clean',
          versionToken: 2,
          storageObjectId: other.storageObjectId,
        })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('clean');
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
        projectUnitId: 12,
        bibleTextId: 3401,
        takeId: 10,
      });

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT));
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
      const secondTake: VerseAudioTakeRecord = {
        ...take,
        id: 11,
        contentHash: 'second-hash',
        storageObjectId: 56,
      };
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, secondTake]));
      vi.mocked(repo.remove).mockResolvedValue(ok(undefined));
      vi.mocked(storageRepo.getById)
        .mockResolvedValueOnce(
          ok({
            id: 55,
            bucket: 'verse-audio',
            key: `unit-12/text-3401/${take.contentHash}`,
            createdAt: new Date(),
            deletedAt: null,
          })
        )
        .mockResolvedValueOnce(
          ok({
            id: 56,
            bucket: 'verse-audio',
            key: 'unit-12/text-3401/second-hash',
            createdAt: new Date(),
            deletedAt: null,
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
      vi.mocked(repo.insertRecording).mockResolvedValue(ok({ ...record, activeTakeId: null }));
      vi.mocked(repo.insertTake).mockResolvedValue(ok(take));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({ applied: true, record })
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

  describe('reclaimOrphanedStorageObjects', () => {
    const orphan = (id: number, key: string) => ({
      id,
      key,
      bucket: 'verse-audio',
      createdAt: new Date(),
      deletedAt: null,
    });

    it('locks and revalidates each candidate before deleting its object', async () => {
      const candidates = [orphan(1, 'unit-9/text-1/a'), orphan(2, 'unit-9/text-2/b')];
      vi.mocked(storageRepo.findOrphans).mockResolvedValue(ok(candidates));
      vi.mocked(storageRepo.reclaimOrphanIfUnreferenced).mockImplementation(
        async (id, _graceMs, deleteObject) => {
          const candidate = candidates.find((item) => item.id === id)!;
          await deleteObject(candidate);
          return ok(true);
        }
      );

      const result = await reclaimOrphanedStorageObjects();

      expect(storageRepo.findOrphans).toHaveBeenCalledWith(expect.any(Number));
      expect(storageRepo.reclaimOrphanIfUnreferenced).toHaveBeenCalledTimes(2);
      expect(deleteVerseAudio).toHaveBeenCalledTimes(2);
      expect(result).toEqual(ok(2));
    });

    it('prunes superseded takes before the orphan sweep, leaving their objects to it', async () => {
      vi.mocked(repo.pruneSupersededTakes).mockResolvedValue(ok(1));
      vi.mocked(storageRepo.findOrphans).mockResolvedValue(ok([]));

      const result = await reclaimOrphanedStorageObjects();

      expect(repo.pruneSupersededTakes).toHaveBeenCalledWith(expect.any(Number));
      // The prune drops rows only. Deleting the blob here would race a concurrent
      // re-upload of the same bytes, which revives that very storage_objects row.
      expect(deleteVerseAudio).not.toHaveBeenCalled();
      expect(storageRepo.markDeleted).not.toHaveBeenCalled();
      expect(result).toEqual(ok(0));
    });

    it('still runs the orphan sweep when the take prune fails', async () => {
      vi.mocked(repo.pruneSupersededTakes).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
      const candidate = orphan(3, 'unit-9/text-3/c');
      vi.mocked(storageRepo.findOrphans).mockResolvedValue(ok([candidate]));
      vi.mocked(storageRepo.reclaimOrphanIfUnreferenced).mockImplementation(
        async (_id, _graceMs, deleteObject) => {
          await deleteObject(candidate);
          return ok(true);
        }
      );

      const result = await reclaimOrphanedStorageObjects();

      expect(storageRepo.findOrphans).toHaveBeenCalled();
      expect(storageRepo.reclaimOrphanIfUnreferenced).toHaveBeenCalledWith(
        3,
        expect.any(Number),
        expect.any(Function)
      );
      expect(result).toEqual(ok(1));
    });
  });
});
