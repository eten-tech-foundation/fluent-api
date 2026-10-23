import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadVerseAudio } from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import * as repo from './verse-audio.repository';
import { uploadRecording } from './verse-audio.service';
import { hashOf, record, take, uploadInput } from './verse-audio.test-fixtures';
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
  get: vi.fn(),
  markConflictPreservingActive: vi.fn(),
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
    it('does not flag conflict when a concurrent first upload reloads the same active take', async () => {
      vi.mocked(repo.get)
        .mockResolvedValueOnce(err(ErrorCode.VERSE_AUDIO_NOT_FOUND))
        .mockResolvedValue(ok(record));
      vi.mocked(repo.createFirstRecordingWithTake).mockResolvedValue(
        ok({ outcome: 'concurrent', record, take })
      );

      const result = await uploadRecording(uploadInput);

      expect(result.ok).toBe(true);
      expect(repo.markConflictPreservingActive).not.toHaveBeenCalled();
    });

    it('flags conflict when a concurrent first upload introduces a different take', async () => {
      const winnerTake = { ...take, contentHash: hashOf(Buffer.from('other')), id: 11 };
      const winner = { ...record, activeTakeId: 11, versionToken: 2 };
      vi.mocked(repo.get)
        .mockResolvedValueOnce(err(ErrorCode.VERSE_AUDIO_NOT_FOUND))
        .mockResolvedValue(ok({ ...winner, conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT }));
      vi.mocked(repo.createFirstRecordingWithTake).mockResolvedValue(
        ok({ outcome: 'concurrent', record: winner, take })
      );
      vi.mocked(repo.markConflictPreservingActive).mockResolvedValue(
        ok({ ...winner, conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT })
      );
      vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take, winnerTake]));

      const result = await uploadRecording(uploadInput);

      expect(repo.markConflictPreservingActive).toHaveBeenCalledWith(winner.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
      }
    });

    it('suppresses false conflicts when content hash already exists on the active take', async () => {
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(takesRepo.findTakeByContentHash).mockResolvedValue(ok(take));

      const result = await uploadRecording({ ...uploadInput, baseVersionToken: 2 });

      expect(result.ok).toBe(true);
      expect(takesRepo.insertTake).not.toHaveBeenCalled();
      expect(uploadVerseAudio).not.toHaveBeenCalled();
      expect(repo.updateRecordingStateIfVersion).not.toHaveBeenCalled();
    });

    it('preserves conflict when a legacy client replaces the active take', async () => {
      const conflicted = {
        ...record,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      };
      const newData = Buffer.from('legacy-over-conflict');
      const newHash = hashOf(newData);
      const newTake = { ...take, contentHash: newHash, id: 11, storageObjectId: 56 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(conflicted))
        .mockResolvedValue(
          ok({
            ...conflicted,
            activeTakeId: 11,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
            storageObjectId: 56,
            versionToken: 2,
          })
        );
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
            ...conflicted,
            activeTakeId: 11,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
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
      expect(vi.mocked(repo.updateRecordingStateIfVersion).mock.calls[0]![2]).not.toHaveProperty(
        'conflictStatus'
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
        expect(result.data.activeTakeId).toBe(11);
      }
    });

    it('does not reopen a resolved conflict when a stale base re-submits a known non-active take', async () => {
      const prior = { ...take, id: 10 };
      const active = {
        ...take,
        contentHash: hashOf(Buffer.from('newer')),
        id: 11,
        storageObjectId: 56,
      };
      const resolved = {
        ...record,
        activeTakeId: 11,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
        storageObjectId: 56,
        versionToken: 4,
      };

      vi.mocked(repo.get).mockResolvedValue(ok(resolved));
      vi.mocked(takesRepo.findTakeByContentHash).mockResolvedValue(ok(prior));
      vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([prior, active]));

      const result = await uploadRecording({
        ...uploadInput,
        baseVersionToken: 1,
        data: Buffer.from('abcd'),
      });

      expect(repo.updateRecordingStateIfVersion).not.toHaveBeenCalled();
      expect(repo.markConflictPreservingActive).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({ conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN }),
          ok: true,
        })
      );
    });

    it('does not let a losing client clear its own conflict by retrying the same bytes', async () => {
      // The stale-base response hands the loser the current token. Re-sending the
      // same bytes may promote its take, but must not settle the contest for it.
      const losing = { ...take, id: 10 };
      const active = { ...take, contentHash: hashOf(Buffer.from('newer')), id: 11 };
      const conflicted = {
        ...record,
        activeTakeId: 11,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
        versionToken: 3,
      };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(conflicted))
        .mockResolvedValue(ok({ ...conflicted, activeTakeId: 10, versionToken: 4 }));
      vi.mocked(takesRepo.findTakeByContentHash).mockResolvedValue(ok(losing));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({ applied: true, record: { ...conflicted, activeTakeId: 10, versionToken: 4 } })
      );
      vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([losing, active]));

      const result = await uploadRecording({ ...uploadInput, baseVersionToken: 3 });

      expect(vi.mocked(repo.updateRecordingStateIfVersion).mock.calls[0]![2]).not.toHaveProperty(
        'conflictStatus'
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
      }
    });

    it('does not reopen a conflict when resolve wins a duplicate-take promotion race', async () => {
      const prior = { ...take, id: 10 };
      const active = {
        ...take,
        contentHash: hashOf(Buffer.from('newer')),
        id: 11,
        storageObjectId: 56,
      };
      const conflicted = {
        ...record,
        activeTakeId: 11,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
        versionToken: 3,
      };
      const resolved = {
        ...conflicted,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
        versionToken: 4,
      };

      vi.mocked(repo.get).mockResolvedValueOnce(ok(conflicted)).mockResolvedValue(ok(resolved));
      vi.mocked(takesRepo.findTakeByContentHash).mockResolvedValue(ok(prior));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({ applied: false, record: null })
      );
      vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([prior, active]));

      const result = await uploadRecording({ ...uploadInput, baseVersionToken: 3 });

      expect(repo.markConflictPreservingActive).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({ conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN }),
          ok: true,
        })
      );
    });

    it('leaves an open conflict alone when a matching-token upload brings new bytes', async () => {
      const newData = Buffer.from('fresh-over-conflict');
      const newHash = hashOf(newData);
      const newTake = { ...take, contentHash: newHash, id: 12, storageObjectId: 56 };
      const conflicted = {
        ...record,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(conflicted))
        .mockResolvedValue(ok({ ...conflicted, activeTakeId: 12, versionToken: 2 }));
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
        ok({ applied: true, record: { ...conflicted, activeTakeId: 12, versionToken: 2 } })
      );
      vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

      const result = await uploadRecording({
        ...uploadInput,
        baseVersionToken: 1,
        data: newData,
      });

      expect(vi.mocked(repo.updateRecordingStateIfVersion).mock.calls[0]![2]).not.toHaveProperty(
        'conflictStatus'
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
      }
    });

    it('keeps a new take and marks conflict when the clean-update CAS loses', async () => {
      const newData = Buffer.from('concurrent');
      const newHash = hashOf(newData);
      const newTake = { ...take, contentHash: newHash, id: 11, storageObjectId: 56 };
      const conflicted = {
        ...record,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      };

      vi.mocked(repo.get).mockResolvedValueOnce(ok(record)).mockResolvedValue(ok(conflicted));
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
        ok({ applied: false, record: null })
      );
      vi.mocked(repo.markConflictPreservingActive).mockResolvedValue(ok(conflicted));
      vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

      const result = await uploadRecording({
        ...uploadInput,
        baseVersionToken: 1,
        data: newData,
      });

      expect(takesRepo.insertTake).toHaveBeenCalledWith(
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
      const conflictTake = { ...take, contentHash: newHash, id: 11, uploadedBy: 9 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(record))
        .mockResolvedValue(
          ok({
            ...record,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
            versionToken: 2,
          })
        );
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
      vi.mocked(takesRepo.insertTake).mockResolvedValue(ok(conflictTake));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: {
            ...record,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
            versionToken: 2,
          },
        })
      );
      vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take, conflictTake]));

      const result = await uploadRecording({
        ...uploadInput,
        baseVersionToken: 2,
        data: newData,
        uploadedBy: 9,
      });

      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
        1,
        expect.objectContaining({
          conflictStatus: 'conflict',
          versionToken: 2,
        })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
        expect(result.data.takes).toHaveLength(2);
        expect(result.data.activeTakeId).toBe(10);
      }
    });
  });
});
