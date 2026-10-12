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
  uploadRangeRecording,
  uploadRecording,
} from './verse-audio.service';
import { VERSE_AUDIO_CONFLICT_STATUS, VERSE_AUDIO_GRANULARITY } from './verse-audio.types';

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
  listByProjectUnit: vi.fn(),
  getBibleTextById: vi.fn(),
  listTakesByRecordingIds: vi.fn(),
  listTakesForRecording: vi.fn(),
  findTakeByContentHash: vi.fn(),
  getTakeById: vi.fn(),
  insertTake: vi.fn(),
  insertRecording: vi.fn(),
  createFirstRecordingWithTake: vi.fn(),
  updateRecordingStateIfVersion: vi.fn(),
  markConflictPreservingActive: vi.fn(),
  markIntersectingCoverageConflicts: vi.fn(),
  updateTakeCoverage: vi.fn(),
  updateTakeCoverageAndRecordingIfVersion: vi.fn(),
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
  granularity: VERSE_AUDIO_GRANULARITY.VERSE,
  startChapter: null,
  startVerse: null,
  endChapter: null,
  endVerse: null,
  activeTakeId: 10,
  bookId: 40,
  chapterNumber: 1,
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
  granularity: VERSE_AUDIO_GRANULARITY.VERSE,
  startChapter: null,
  startVerse: null,
  endChapter: null,
  endVerse: null,
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
    vi.mocked(repo.markIntersectingCoverageConflicts).mockResolvedValue(ok({ markedIds: [] }));
    vi.mocked(repo.getBibleTextById).mockResolvedValue(
      ok({ id: 3401, bookId: 40, chapterNumber: 1, verseNumber: 3 })
    );
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
          projectUnitId: 12,
          bibleTextId: 3401,
          versionToken: 1,
          activeTakeId: null,
        }),
        expect.objectContaining({ contentHash: take.contentHash })
      );
      expect(repo.markConflictPreservingActive).not.toHaveBeenCalled();
    });

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
      const winnerTake = { ...take, id: 11, contentHash: hashOf(Buffer.from('other')) };
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
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, winnerTake]));

      const result = await uploadRecording(uploadInput);

      expect(repo.markConflictPreservingActive).toHaveBeenCalledWith(winner.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.conflictStatus).toBe('conflict');
      }
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
      // Same geometry as current unit — promote must not re-run overlap marking.
      expect(repo.markIntersectingCoverageConflicts).not.toHaveBeenCalled();
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

    it('does not reopen a resolved conflict when a stale base re-submits a known non-active take', async () => {
      const prior = { ...take, id: 10 };
      const active = {
        ...take,
        id: 11,
        contentHash: hashOf(Buffer.from('newer')),
        storageObjectId: 56,
      };
      const resolved = {
        ...record,
        versionToken: 4,
        activeTakeId: 11,
        storageObjectId: 56,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
      };

      vi.mocked(repo.get).mockResolvedValue(ok(resolved));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(prior));
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([prior, active]));

      const result = await uploadRecording({
        ...uploadInput,
        data: Buffer.from('abcd'),
        baseVersionToken: 1,
      });

      expect(repo.updateRecordingStateIfVersion).not.toHaveBeenCalled();
      expect(repo.markConflictPreservingActive).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({ conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN }),
        })
      );
    });

    it('logs when a legacy client omits baseVersionToken', async () => {
      const { logger } = await import('@/lib/logger');
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(take));

      await uploadRecording(uploadInput);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'verse_audio_upload_legacy_no_token' }),
        expect.stringContaining('legacy replace')
      );
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

    it('does not reopen a conflict when resolve wins a duplicate-take promotion race', async () => {
      const prior = { ...take, id: 10 };
      const active = {
        ...take,
        id: 11,
        contentHash: hashOf(Buffer.from('newer')),
        storageObjectId: 56,
      };
      const conflicted = {
        ...record,
        versionToken: 3,
        activeTakeId: 11,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      };
      const resolved = {
        ...conflicted,
        versionToken: 4,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
      };

      vi.mocked(repo.get).mockResolvedValueOnce(ok(conflicted)).mockResolvedValue(ok(resolved));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(prior));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({ applied: false, record: null })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([prior, active]));

      const result = await uploadRecording({ ...uploadInput, baseVersionToken: 3 });

      expect(repo.markConflictPreservingActive).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({ conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN }),
        })
      );
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

  describe('uploadRangeRecording', () => {
    const rangeInput = {
      projectUnitId: 12,
      bibleTextId: 3401,
      uploadedBy: 7,
      contentType: 'audio/mp4' as const,
      data: Buffer.from('range-abcd'),
      durationSeconds: 20,
      baseVersionToken: 1 as number | undefined,
      granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
      startChapter: 1,
      startVerse: 3,
      endChapter: 1,
      endVerse: 8,
    };

    const pericopeShape = {
      granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
      startChapter: 1,
      startVerse: 3,
      endChapter: 1,
      endVerse: 8,
    };

    beforeEach(() => {
      vi.mocked(repo.getBibleTextById).mockResolvedValue(
        ok({ id: 3401, bookId: 40, chapterNumber: 1, verseNumber: 3 })
      );
      vi.mocked(repo.listByProjectUnit).mockResolvedValue(ok([]));
    });

    it('persists pericope shape on first upload', async () => {
      const rangeTake = { ...take, ...pericopeShape, contentHash: hashOf(rangeInput.data) };
      const rangeRecord = {
        ...record,
        ...pericopeShape,
        versionToken: 2,
        activeTakeId: 10,
      };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(err(ErrorCode.VERSE_AUDIO_NOT_FOUND))
        .mockResolvedValue(ok(rangeRecord));
      vi.mocked(repo.createFirstRecordingWithTake).mockResolvedValue(
        ok({ outcome: 'created', record: rangeRecord, take: rangeTake })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([rangeTake]));

      const result = await uploadRangeRecording(rangeInput);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.granularity).toBe('pericope');
        expect(result.data.startChapter).toBe(1);
        expect(result.data.startVerse).toBe(3);
        expect(result.data.endChapter).toBe(1);
        expect(result.data.endVerse).toBe(8);
        expect(result.data.takes[0]?.granularity).toBe('pericope');
      }
      expect(repo.createFirstRecordingWithTake).toHaveBeenCalledWith(
        expect.objectContaining(pericopeShape),
        expect.objectContaining(pericopeShape)
      );
    });

    it('rejects empty / zero / reversed / malformed ranges', async () => {
      for (const bad of [
        { startChapter: 0, startVerse: 1, endChapter: 1, endVerse: 2 },
        { startChapter: 1, startVerse: 5, endChapter: 1, endVerse: 2 },
        { startChapter: 1.5, startVerse: 1, endChapter: 1, endVerse: 2 },
      ]) {
        const result = await uploadRangeRecording({ ...rangeInput, ...bad } as any);
        expect(result).toEqual(err(ErrorCode.VALIDATION_ERROR));
      }
      expect(repo.createFirstRecordingWithTake).not.toHaveBeenCalled();
      expect(uploadVerseAudio).not.toHaveBeenCalled();
    });

    it('rejects when bibleTextId does not match start chapter/verse', async () => {
      vi.mocked(repo.getBibleTextById).mockResolvedValue(
        ok({ id: 3401, bookId: 40, chapterNumber: 1, verseNumber: 1 })
      );

      const result = await uploadRangeRecording(rangeInput);

      expect(result).toEqual(err(ErrorCode.INVALID_REFERENCE));
      expect(repo.createFirstRecordingWithTake).not.toHaveBeenCalled();
    });

    it('marks intersecting other recordings conflict without bumping their tokens', async () => {
      const rangeTake = { ...take, ...pericopeShape, contentHash: hashOf(rangeInput.data) };
      const rangeRecord = { ...record, ...pericopeShape, versionToken: 2 };
      const otherVerse: VerseAudioRecord = {
        ...record,
        id: 2,
        bibleTextId: 3402,
        verseNumber: 5,
        chapterNumber: 1,
        bookId: 40,
        versionToken: 4,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
      };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(err(ErrorCode.VERSE_AUDIO_NOT_FOUND))
        .mockResolvedValue(ok(rangeRecord));
      vi.mocked(repo.createFirstRecordingWithTake).mockResolvedValue(
        ok({ outcome: 'created', record: rangeRecord, take: rangeTake })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([rangeTake]));
      vi.mocked(repo.markIntersectingCoverageConflicts).mockResolvedValue(
        ok({ markedIds: [rangeRecord.id, otherVerse.id] })
      );

      const result = await uploadRangeRecording({ ...rangeInput, baseVersionToken: undefined });

      expect(result.ok).toBe(true);
      expect(repo.markIntersectingCoverageConflicts).toHaveBeenCalledWith({
        projectUnitId: 12,
        selfBibleTextId: 3401,
        bookId: 40,
        coverage: { start: { chapter: 1, verse: 3 }, end: { chapter: 1, verse: 8 } },
      });
      // Geometric conflicts flag both units without CAS/version bumps on the other row.
      expect(repo.updateRecordingStateIfVersion).not.toHaveBeenCalledWith(
        2,
        expect.anything(),
        expect.anything()
      );
    });

    it('preserves single-verse upload shape defaults when shape is omitted', async () => {
      vi.mocked(repo.get)
        .mockResolvedValueOnce(err(ErrorCode.VERSE_AUDIO_NOT_FOUND))
        .mockResolvedValue(ok({ ...record, versionToken: 2 }));
      vi.mocked(repo.createFirstRecordingWithTake).mockResolvedValue(
        ok({
          outcome: 'created',
          record: { ...record, versionToken: 2 },
          take,
        })
      );

      await uploadRecording(uploadInput);

      expect(repo.createFirstRecordingWithTake).toHaveBeenCalledWith(
        expect.objectContaining({
          granularity: 'verse',
          startChapter: null,
          startVerse: null,
          endChapter: null,
          endVerse: null,
        }),
        expect.objectContaining({
          granularity: 'verse',
          startChapter: null,
        })
      );
    });

    it('keeps verse take metadata when pericope replaces active on same anchor', async () => {
      const verseTake = { ...take };
      const pericopeData = Buffer.from('pericope-bytes');
      const pericopeHash = hashOf(pericopeData);
      const pericopeTake = {
        ...take,
        id: 11,
        contentHash: pericopeHash,
        storageObjectId: 56,
        ...pericopeShape,
      };
      const unit = { ...record, versionToken: 2, activeTakeId: 10 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(unit))
        .mockResolvedValue(
          ok({
            ...unit,
            ...pericopeShape,
            versionToken: 3,
            activeTakeId: 11,
          })
        );
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(null));
      vi.mocked(storageRepo.claim).mockResolvedValue(
        ok({
          id: 56,
          bucket: 'verse-audio',
          key: `unit-12/text-3401/${pericopeHash}`,
          createdAt: new Date(),
          deletedAt: null,
        })
      );
      vi.mocked(repo.insertTake).mockResolvedValue(ok(pericopeTake));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: { ...unit, ...pericopeShape, versionToken: 3, activeTakeId: 11 },
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([verseTake, pericopeTake]));

      const result = await uploadRangeRecording({
        ...rangeInput,
        data: pericopeData,
        baseVersionToken: 2,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const verse = result.data.takes.find((x) => x.id === 10);
        const peri = result.data.takes.find((x) => x.id === 11);
        expect(verse?.granularity).toBe('verse');
        expect(verse?.startChapter).toBeNull();
        expect(peri?.granularity).toBe('pericope');
        expect(peri?.endVerse).toBe(8);
        expect(result.data.granularity).toBe('pericope');
      }
    });

    it('does not reflag overlaps on active same-shape retry after resolve', async () => {
      const cleanUnit = {
        ...record,
        ...pericopeShape,
        versionToken: 5,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
        activeTakeId: 10,
      };
      const activePericope = { ...take, ...pericopeShape };
      vi.mocked(repo.get).mockResolvedValue(ok(cleanUnit));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(activePericope));
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([activePericope]));

      const result = await uploadRangeRecording({
        ...rangeInput,
        data: Buffer.from('abcd'),
        baseVersionToken: 5,
      });

      expect(result.ok).toBe(true);
      expect(repo.markIntersectingCoverageConflicts).not.toHaveBeenCalled();
      expect(repo.insertTake).not.toHaveBeenCalled();
    });

    it('does not reflag overlaps on stale duplicate of a non-active take', async () => {
      const cleanUnit = {
        ...record,
        ...pericopeShape,
        versionToken: 5,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
        activeTakeId: 11,
      };
      const staleDup = { ...take, id: 10, ...pericopeShape };
      vi.mocked(repo.get).mockResolvedValue(ok(cleanUnit));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(staleDup));
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([staleDup, { ...take, id: 11 }]));

      const result = await uploadRangeRecording({
        ...rangeInput,
        data: Buffer.from('abcd'),
        baseVersionToken: 1, // stale
      });

      expect(result.ok).toBe(true);
      expect(repo.markIntersectingCoverageConflicts).not.toHaveBeenCalled();
      expect(repo.insertTake).not.toHaveBeenCalled();
    });

    it('does not reflag overlaps when promoting a same-geometry non-active take after resolve', async () => {
      const cleanUnit = {
        ...record,
        ...pericopeShape,
        versionToken: 5,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
        activeTakeId: 11,
      };
      const prior = { ...take, id: 10, ...pericopeShape };
      const active = {
        ...take,
        id: 11,
        ...pericopeShape,
        contentHash: hashOf(Buffer.from('other')),
      };
      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(cleanUnit))
        .mockResolvedValue(ok({ ...cleanUnit, versionToken: 6, activeTakeId: 10 }));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(prior));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({ applied: true, record: { ...cleanUnit, versionToken: 6, activeTakeId: 10 } })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([prior, active]));

      const result = await uploadRangeRecording({
        ...rangeInput,
        data: Buffer.from('abcd'),
        baseVersionToken: 5,
      });

      expect(result.ok).toBe(true);
      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalled();
      expect(repo.markIntersectingCoverageConflicts).not.toHaveBeenCalled();
    });

    it('scans overlaps when promoting a non-active take changes active coverage geometry', async () => {
      const cleanUnit = {
        ...record,
        versionToken: 5,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
        activeTakeId: 11,
        granularity: VERSE_AUDIO_GRANULARITY.VERSE,
        startChapter: null,
        startVerse: null,
        endChapter: null,
        endVerse: null,
      };
      // Take already stores the requested pericope shape; unit denormalized coverage is still verse.
      const prior = { ...take, id: 10, ...pericopeShape };
      const active = { ...take, id: 11 };
      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(cleanUnit))
        .mockResolvedValue(
          ok({ ...cleanUnit, ...pericopeShape, versionToken: 6, activeTakeId: 10 })
        );
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(prior));
      vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
        ok({
          applied: true,
          record: { ...cleanUnit, ...pericopeShape, versionToken: 6, activeTakeId: 10 },
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([prior, active]));
      vi.mocked(repo.markIntersectingCoverageConflicts).mockResolvedValue(
        ok({ markedIds: [1, 2] })
      );

      const result = await uploadRangeRecording({
        ...rangeInput,
        data: Buffer.from('abcd'),
        baseVersionToken: 5,
      });

      expect(result.ok).toBe(true);
      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalled();
      expect(repo.markIntersectingCoverageConflicts).toHaveBeenCalled();
    });

    it('still scans overlaps when a stale upload inserts a new contender', async () => {
      const cleanUnit = {
        ...record,
        versionToken: 5,
        conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
        activeTakeId: 10,
      };
      const newData = Buffer.from('stale-new-contender');
      const newHash = hashOf(newData);
      const newTake = {
        ...take,
        id: 12,
        contentHash: newHash,
        storageObjectId: 57,
        ...pericopeShape,
      };
      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(cleanUnit))
        .mockResolvedValue(
          ok({
            ...cleanUnit,
            versionToken: 6,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
          })
        );
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(null));
      vi.mocked(storageRepo.claim).mockResolvedValue(
        ok({
          id: 57,
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
            ...cleanUnit,
            versionToken: 6,
            conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
          },
        })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));
      vi.mocked(repo.markIntersectingCoverageConflicts).mockResolvedValue(
        ok({ markedIds: [1, 2] })
      );

      const result = await uploadRangeRecording({
        ...rangeInput,
        data: newData,
        baseVersionToken: 1, // stale — new contender kept, conflict flagged
      });

      expect(result.ok).toBe(true);
      expect(repo.insertTake).toHaveBeenCalled();
      expect(repo.markIntersectingCoverageConflicts).toHaveBeenCalled();
    });

    it('returns 409 when active-take coverage CAS misses (applied: false)', async () => {
      const unit = { ...record, versionToken: 2, activeTakeId: 10 };
      vi.mocked(repo.get).mockResolvedValue(ok(unit));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(take));
      vi.mocked(repo.updateTakeCoverageAndRecordingIfVersion).mockResolvedValue(
        ok({ applied: false, record: null })
      );

      const result = await uploadRangeRecording({
        ...rangeInput,
        data: Buffer.from('abcd'),
        endVerse: 10,
        baseVersionToken: 2,
      });

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT));
      expect(repo.updateTakeCoverageAndRecordingIfVersion).toHaveBeenCalled();
      expect(repo.markConflictPreservingActive).not.toHaveBeenCalled();
      expect(repo.markIntersectingCoverageConflicts).not.toHaveBeenCalled();
    });

    it('returns 409 for omitted-token legacy shape change when atomic CAS misses', async () => {
      const unit = { ...record, versionToken: 2, activeTakeId: 10 };
      vi.mocked(repo.get).mockResolvedValue(ok(unit));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(take));
      vi.mocked(repo.updateTakeCoverageAndRecordingIfVersion).mockResolvedValue(
        ok({ applied: false, record: null })
      );

      // Omit baseVersionToken → legacyReplace path; failed promote is not 200 success.
      const { baseVersionToken: _omit, ...legacyInput } = rangeInput;
      const result = await uploadRangeRecording({
        ...legacyInput,
        data: Buffer.from('abcd'),
        endVerse: 10,
      });

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT));
      expect(repo.updateTakeCoverageAndRecordingIfVersion).toHaveBeenCalledWith(
        10,
        1,
        2,
        expect.objectContaining({ endVerse: 10 }),
        expect.objectContaining({ versionToken: 3, endVerse: 10 })
      );
      expect(repo.updateTakeCoverage).not.toHaveBeenCalled();
      expect(repo.markConflictPreservingActive).not.toHaveBeenCalled();
      expect(repo.markIntersectingCoverageConflicts).not.toHaveBeenCalled();
    });

    it('returns 409 for non-active duplicate shape promote when atomic CAS misses', async () => {
      const unit = { ...record, versionToken: 2, activeTakeId: 11 };
      const staleDup = { ...take, id: 10 };
      vi.mocked(repo.get).mockResolvedValue(ok(unit));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(staleDup));
      vi.mocked(repo.updateTakeCoverageAndRecordingIfVersion).mockResolvedValue(
        ok({ applied: false, record: null })
      );

      const result = await uploadRangeRecording({
        ...rangeInput,
        data: Buffer.from('abcd'),
        endVerse: 10,
        baseVersionToken: 2,
      });

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT));
      expect(repo.updateTakeCoverageAndRecordingIfVersion).toHaveBeenCalledWith(
        10,
        1,
        2,
        expect.objectContaining({ endVerse: 10 }),
        expect.objectContaining({ activeTakeId: 10, versionToken: 3 })
      );
      expect(repo.markConflictPreservingActive).not.toHaveBeenCalled();
      expect(repo.markIntersectingCoverageConflicts).not.toHaveBeenCalled();
    });

    it('updates coverage on duplicate contentHash with a different range shape', async () => {
      const unit = { ...record, versionToken: 2, activeTakeId: 10 };
      const newShape = {
        granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
        startChapter: 1,
        startVerse: 3,
        endChapter: 1,
        endVerse: 10,
      };
      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(unit))
        .mockResolvedValue(ok({ ...unit, ...newShape, versionToken: 3 }));
      vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(take));
      vi.mocked(repo.updateTakeCoverageAndRecordingIfVersion).mockResolvedValue(
        ok({ applied: true, record: { ...unit, ...newShape, versionToken: 3 } })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([{ ...take, ...newShape }]));

      const result = await uploadRangeRecording({
        ...rangeInput,
        data: Buffer.from('abcd'), // same bytes as take
        endVerse: 10,
        baseVersionToken: 2,
      });

      expect(result.ok).toBe(true);
      expect(repo.updateTakeCoverageAndRecordingIfVersion).toHaveBeenCalledWith(
        10,
        1,
        2,
        newShape,
        expect.objectContaining({ ...newShape, versionToken: 3 })
      );
      expect(repo.insertTake).not.toHaveBeenCalled();
      expect(repo.markIntersectingCoverageConflicts).toHaveBeenCalled();
    });

    it('still supports matching version tokens on range re-upload', async () => {
      const newData = Buffer.from('range-next');
      const newHash = hashOf(newData);
      const newTake = {
        ...take,
        id: 11,
        contentHash: newHash,
        storageObjectId: 56,
        ...pericopeShape,
      };
      const unit = { ...record, ...pericopeShape, versionToken: 3 };

      vi.mocked(repo.get)
        .mockResolvedValueOnce(ok(unit))
        .mockResolvedValue(ok({ ...unit, versionToken: 4, activeTakeId: 11 }));
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
        ok({ applied: true, record: { ...unit, versionToken: 4, activeTakeId: 11 } })
      );
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

      const result = await uploadRangeRecording({
        ...rangeInput,
        data: newData,
        baseVersionToken: 3,
      });

      expect(result.ok).toBe(true);
      expect(repo.insertTake).toHaveBeenCalledWith(expect.objectContaining(pericopeShape));
      expect(repo.updateRecordingStateIfVersion).toHaveBeenCalledWith(
        1,
        3,
        expect.objectContaining({ ...pericopeShape, versionToken: 4, activeTakeId: 11 })
      );
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
        expect(result.data.granularity).toBe('verse');
        expect(result.data.startChapter).toBeNull();
        expect(result.data.takes[0]?.granularity).toBe('verse');
      }
      // Hash-keyed objects derive the blob name — no storage_objects round trip.
      expect(storageRepo.getByIds).not.toHaveBeenCalled();
      expect(storageRepo.getById).not.toHaveBeenCalled();
      expect(generateAudioDownloadUrl).toHaveBeenCalledWith(
        `unit-12/text-3401/${take.contentHash}`
      );
    });

    it('echoes pericope range fields on get', async () => {
      const rangeRecord = {
        ...record,
        granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
        startChapter: 1,
        startVerse: 3,
        endChapter: 1,
        endVerse: 8,
      };
      const rangeTake = {
        ...take,
        granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
        startChapter: 1,
        startVerse: 3,
        endChapter: 1,
        endVerse: 8,
      };
      vi.mocked(repo.get).mockResolvedValue(ok(rangeRecord));
      vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([rangeTake]));

      const result = await getRecording(12, 3401);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual(
          expect.objectContaining({
            granularity: 'pericope',
            startChapter: 1,
            startVerse: 3,
            endChapter: 1,
            endVerse: 8,
          })
        );
        expect(result.data.takes[0]).toEqual(
          expect.objectContaining({
            granularity: 'pericope',
            endVerse: 8,
          })
        );
      }
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

      const result = await listChapterRecordings(12, 9, 1, 3);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items).toHaveLength(2);
        expect(result.data.hasConflict).toBe(true);
      }
      expect(repo.listByChapter).toHaveBeenCalledWith(12, 9, 1, 3);
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
          granularity: other.granularity,
          startChapter: other.startChapter,
          startVerse: other.startVerse,
          endChapter: other.endChapter,
          endVerse: other.endVerse,
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
