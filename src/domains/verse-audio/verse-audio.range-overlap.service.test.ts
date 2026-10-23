import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadVerseAudio } from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import { uploadRangeRecording } from './verse-audio.range.service';
import * as repo from './verse-audio.repository';
import { hashOf, record, take } from './verse-audio.test-fixtures';
import { VERSE_AUDIO_CONFLICT_STATUS, VERSE_AUDIO_GRANULARITY } from './verse-audio.types';

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
  getBibleTextById: vi.fn(),
  getTakeById: vi.fn(),
  insertTake: vi.fn(),
  listByChapter: vi.fn(),
  listTakesByRecordingIds: vi.fn(),
  listTakesForRecording: vi.fn(),
  markConflictPreservingActive: vi.fn(),
  markIntersectingCoverageConflicts: vi.fn(),
  remove: vi.fn(),
  updateRecordingStateIfVersion: vi.fn(),
  updateTakeCoverageAndRecordingIfVersion: vi.fn(),
}));

vi.mock('./verse-audio-takes.repository', () => ({
  findTakeByContentHash: vi.fn(),
  getTakeById: vi.fn(),
  insertTake: vi.fn(),
  listTakesByRecordingIds: vi.fn(),
  listTakesForRecording: vi.fn(),
  pruneSupersededTakes: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

describe('uploadRangeRecording overlap scans', () => {
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
    vi.mocked(uploadVerseAudio).mockResolvedValue(undefined);
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take]));
    vi.mocked(takesRepo.listTakesByRecordingIds).mockResolvedValue(ok([take]));
    vi.mocked(repo.getBibleTextById).mockResolvedValue(
      ok({ id: 3401, bookId: 40, chapterNumber: 1, verseNumber: 3 })
    );
    vi.mocked(repo.markIntersectingCoverageConflicts).mockResolvedValue(ok({ markedIds: [] }));
  });

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
      .mockResolvedValue(ok({ ...cleanUnit, ...pericopeShape, versionToken: 6, activeTakeId: 10 }));
    vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(prior));
    vi.mocked(repo.updateRecordingStateIfVersion).mockResolvedValue(
      ok({
        applied: true,
        record: { ...cleanUnit, ...pericopeShape, versionToken: 6, activeTakeId: 10 },
      })
    );
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([prior, active]));
    vi.mocked(repo.markIntersectingCoverageConflicts).mockResolvedValue(ok({ markedIds: [1, 2] }));

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
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));
    vi.mocked(repo.markIntersectingCoverageConflicts).mockResolvedValue(ok({ markedIds: [1, 2] }));

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
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([{ ...take, ...newShape }]));

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
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take, newTake]));

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
