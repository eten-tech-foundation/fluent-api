import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadVerseAudio } from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';

import type { VerseAudioRecord } from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import { uploadRangeRecording } from './verse-audio.range.service';
import * as repo from './verse-audio.repository';
import { hashOf, record, take, uploadInput } from './verse-audio.test-fixtures';
import { VERSE_AUDIO_CONFLICT_STATUS, VERSE_AUDIO_GRANULARITY } from './verse-audio.types';
import { uploadRecording } from './verse-audio.upload.service';

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

describe('uploadRangeRecording', () => {
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
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([rangeTake]));

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
      const result = await uploadRangeRecording({
        ...rangeInput,
        ...bad,
      } as Parameters<typeof uploadRangeRecording>[0]);
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
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([rangeTake]));
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
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([verseTake, pericopeTake]));

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
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([activePericope]));

    const result = await uploadRangeRecording({
      ...rangeInput,
      data: Buffer.from('abcd'),
      baseVersionToken: 5,
    });

    expect(result.ok).toBe(true);
    expect(repo.markIntersectingCoverageConflicts).not.toHaveBeenCalled();
    expect(repo.insertTake).not.toHaveBeenCalled();
  });

  it('does not reflag overlaps when verse↔one-verse pericope metadata changes at same bounds', async () => {
    // Contract: one-verse pericopes are valid (end >= start). Overlap scan uses
    // geometric coverageFromActive ranges — granularity alone is not a conflict axis.
    const oneVersePericope = {
      granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
      startChapter: 1,
      startVerse: 3,
      endChapter: 1,
      endVerse: 3,
    };
    const cleanVerseUnit = {
      ...record,
      versionToken: 5,
      conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
      activeTakeId: 10,
      granularity: VERSE_AUDIO_GRANULARITY.VERSE,
      startChapter: null,
      startVerse: null,
      endChapter: null,
      endVerse: null,
      chapterNumber: 1,
      verseNumber: 3,
    };
    vi.mocked(repo.get)
      .mockResolvedValueOnce(ok(cleanVerseUnit))
      .mockResolvedValue(ok({ ...cleanVerseUnit, ...oneVersePericope, versionToken: 6 }));
    vi.mocked(repo.findTakeByContentHash).mockResolvedValue(ok(take));
    vi.mocked(repo.updateTakeCoverageAndRecordingIfVersion).mockResolvedValue(
      ok({
        applied: true,
        record: { ...cleanVerseUnit, ...oneVersePericope, versionToken: 6 },
      })
    );
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(
      ok([{ ...take, ...oneVersePericope }])
    );

    const result = await uploadRangeRecording({
      ...rangeInput,
      data: Buffer.from('abcd'),
      endVerse: 3,
      baseVersionToken: 5,
    });

    expect(result.ok).toBe(true);
    // Metadata rewrite still happens (full shape includes granularity).
    expect(repo.updateTakeCoverageAndRecordingIfVersion).toHaveBeenCalled();
    expect(repo.markIntersectingCoverageConflicts).not.toHaveBeenCalled();
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
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(
      ok([staleDup, { ...take, id: 11 }])
    );

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
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([prior, active]));

    const result = await uploadRangeRecording({
      ...rangeInput,
      data: Buffer.from('abcd'),
      baseVersionToken: 5,
    });

    expect(result.ok).toBe(true);
    expect(repo.updateRecordingStateIfVersion).toHaveBeenCalled();
    expect(repo.markIntersectingCoverageConflicts).not.toHaveBeenCalled();
  });
});
