import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateAudioDownloadUrl } from '@/lib/audio-storage';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { VerseAudioRecord, VerseAudioTakeRecord } from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import * as repo from './verse-audio.repository';
import { hydrateCoverageForWire } from './verse-audio.responses';
import { getRecording, listChapterRecordings } from './verse-audio.service';
import { record, take } from './verse-audio.test-fixtures';
import {
  VERSE_AUDIO_CONFLICT_STATUS,
  VERSE_AUDIO_GRANULARITY,
  verseAudioResponseSchema,
} from './verse-audio.types';

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
  listByChapter: vi.fn(),
  markConflictPreservingActive: vi.fn(),
  remove: vi.fn(),
  updateRecordingStateIfVersion: vi.fn(),
}));

vi.mock('./verse-audio-takes.repository', () => ({
  getTakeById: vi.fn(),
  listTakesByRecordingIds: vi.fn(),
  listTakesForRecording: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const wireContractPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/features/selected-canonical-hydration/reference/wire-contract.json'
);

interface WireContractFixture {
  verseMatchedActive: Record<string, unknown>;
  pericopeMatchedActive: Record<string, unknown>;
  nullActiveUnavailable: Record<string, unknown>;
  unmatchedActiveUnavailable: Record<string, unknown>;
}

function loadWireContract(): WireContractFixture {
  return JSON.parse(readFileSync(wireContractPath, 'utf8')) as WireContractFixture;
}

function signedUrl(projectUnitId: number, bibleTextId: number, contentHash: string): string {
  return `https://r2.example/unit-${projectUnitId}/text-${bibleTextId}/${contentHash}?sig=x`;
}

/** Replace fixture hash placeholders with real hashes used by the test doubles. */
function withHashes(
  fixture: Record<string, unknown>,
  hashes: Record<string, string>
): Record<string, unknown> {
  const raw = JSON.stringify(fixture);
  const replaced = Object.entries(hashes).reduce(
    (acc, [token, hash]) => acc.replaceAll(token, hash),
    raw
  );
  return JSON.parse(replaced) as Record<string, unknown>;
}

describe('hydrateCoverageForWire', () => {
  it('fills inclusive verse anchors from bible_texts', () => {
    expect(
      hydrateCoverageForWire(
        {
          granularity: VERSE_AUDIO_GRANULARITY.VERSE,
          startChapter: null,
          startVerse: null,
          endChapter: null,
          endVerse: null,
        },
        1,
        3
      )
    ).toEqual({
      granularity: 'verse',
      startChapter: 1,
      startVerse: 3,
      endChapter: 1,
      endVerse: 3,
    });
  });

  it('preserves pericope bounds including cross-chapter end', () => {
    expect(
      hydrateCoverageForWire(
        {
          granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
          startChapter: 1,
          startVerse: 3,
          endChapter: 2,
          endVerse: 4,
        },
        1,
        3
      )
    ).toEqual({
      granularity: 'pericope',
      startChapter: 1,
      startVerse: 3,
      endChapter: 2,
      endVerse: 4,
    });
  });
});

describe('selected-canonical hydration', () => {
  const verseHash = 'a'.repeat(64);
  const pericopeHash = 'b'.repeat(64);
  const orphanHash = 'c'.repeat(64);
  const onlyTakeHash = 'd'.repeat(64);

  const verseTake: VerseAudioTakeRecord = {
    ...take,
    contentHash: verseHash,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageRepo.getByIds).mockResolvedValue(ok([]));
    vi.mocked(generateAudioDownloadUrl).mockImplementation(async (key: string) => {
      return `https://r2.example/${key}?sig=x`;
    });
  });

  it('hydrates single-verse unit with anchors, matched hash URL, and OpenAPI shape', async () => {
    vi.mocked(repo.get).mockResolvedValue(ok(record));
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([verseTake]));

    const result = await getRecording(12, 3401);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.activeTakeId).toBe(10);
    expect(result.data.granularity).toBe('verse');
    expect(result.data).toMatchObject({
      startChapter: 1,
      startVerse: 3,
      endChapter: 1,
      endVerse: 3,
    });
    expect(result.data.takes[0]?.contentHash).toBe(verseHash);
    expect(result.data.downloadUrl).toBe(signedUrl(12, 3401, verseHash));
    expect(result.data.downloadUrl).toBe(result.data.takes[0]?.downloadUrl);
    expect(verseAudioResponseSchema.safeParse(result.data).success).toBe(true);

    const fixture = withHashes(loadWireContract().verseMatchedActive, {
      HASH_VERSE: verseHash,
    });
    expect(result.data).toEqual(fixture);
  });

  it('hydrates same-anchor mixed takes from the exact active pericope take', async () => {
    const unit: VerseAudioRecord = {
      ...record,
      id: 2,
      conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
      startChapter: 1,
      startVerse: 3,
      endChapter: 2,
      endVerse: 4,
      activeTakeId: 20,
      sizeBytes: 8,
      durationSeconds: 40,
      versionToken: 3,
      updatedAt: new Date('2026-07-02T00:00:00Z'),
    };
    const periTake: VerseAudioTakeRecord = {
      ...take,
      id: 20,
      uploadedBy: 9,
      contentHash: pericopeHash,
      sizeBytes: 8,
      durationSeconds: 40,
      granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
      startChapter: 1,
      startVerse: 3,
      endChapter: 2,
      endVerse: 4,
      createdAt: new Date('2026-07-02T00:00:00Z'),
      updatedAt: new Date('2026-07-02T00:00:00Z'),
    };

    vi.mocked(repo.get).mockResolvedValue(ok(unit));
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([verseTake, periTake]));

    const result = await getRecording(12, 3401);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.activeTakeId).toBe(20);
    expect(result.data.conflictStatus).toBe('conflict');
    expect(result.data.granularity).toBe('pericope');
    expect(result.data).toMatchObject({
      startChapter: 1,
      startVerse: 3,
      endChapter: 2,
      endVerse: 4,
    });
    expect(result.data.downloadUrl).toBe(signedUrl(12, 3401, pericopeHash));
    expect(result.data.downloadUrl).not.toBe(signedUrl(12, 3401, verseHash));
    expect(result.data.takes).toHaveLength(2);

    const fixture = withHashes(loadWireContract().pericopeMatchedActive, {
      HASH_VERSE: verseHash,
      HASH_PERICOPE: pericopeHash,
    });
    expect(result.data).toEqual(fixture);
  });

  it('keeps null activeTakeId explicitly unavailable (no last-take invent)', async () => {
    const unit: VerseAudioRecord = {
      ...record,
      id: 3,
      bibleTextId: 3402,
      verseNumber: 4,
      activeTakeId: null,
    };
    const orphan: VerseAudioTakeRecord = {
      ...take,
      id: 30,
      recordingId: 3,
      contentHash: orphanHash,
    };

    vi.mocked(repo.get).mockResolvedValue(ok(unit));
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([orphan]));

    const result = await getRecording(12, 3402);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.activeTakeId).toBeNull();
    expect(result.data.downloadUrl).toBeNull();
    expect(result.data.takes).toHaveLength(1);
    expect(result.data.takes[0]?.downloadUrl).toBe(signedUrl(12, 3402, orphanHash));
    expect(result.data).toMatchObject({
      startChapter: 1,
      startVerse: 4,
      endChapter: 1,
      endVerse: 4,
    });

    const fixture = withHashes(loadWireContract().nullActiveUnavailable, {
      HASH_ORPHAN: orphanHash,
    });
    expect(result.data).toEqual(fixture);
  });

  it('keeps unmatched activeTakeId explicitly unavailable (no invent-take)', async () => {
    const unit: VerseAudioRecord = {
      ...record,
      id: 4,
      bibleTextId: 3403,
      verseNumber: 5,
      activeTakeId: 999,
      conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      versionToken: 2,
    };
    const only: VerseAudioTakeRecord = {
      ...take,
      id: 40,
      recordingId: 4,
      contentHash: onlyTakeHash,
    };

    vi.mocked(repo.get).mockResolvedValue(ok(unit));
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([only]));

    const result = await getRecording(12, 3403);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.activeTakeId).toBe(999);
    expect(result.data.downloadUrl).toBeNull();
    expect(result.data.conflictStatus).toBe('conflict');
    expect(result.data.takes[0]?.id).toBe(40);
    expect(result.data.takes[0]?.downloadUrl).toBe(signedUrl(12, 3403, onlyTakeHash));
    expect(logger.warn).toHaveBeenCalledWith({
      message: 'Verse audio activeTakeId has no matching take; top-level download unavailable',
      context: {
        recordingId: 4,
        projectUnitId: 12,
        bibleTextId: 3403,
        activeTakeId: 999,
        takeIds: [40],
      },
    });

    const fixture = withHashes(loadWireContract().unmatchedActiveUnavailable, {
      HASH_ONLY_TAKE: onlyTakeHash,
    });
    expect(result.data).toEqual(fixture);
  });

  it('keeps list and unit GET consistent for the same unit', async () => {
    const periUnit: VerseAudioRecord = {
      ...record,
      granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
      startChapter: 1,
      startVerse: 3,
      endChapter: 1,
      endVerse: 8,
      activeTakeId: 20,
    };
    const periTake: VerseAudioTakeRecord = {
      ...take,
      id: 20,
      contentHash: pericopeHash,
      granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
      startChapter: 1,
      startVerse: 3,
      endChapter: 1,
      endVerse: 8,
    };

    vi.mocked(repo.get).mockResolvedValue(ok(periUnit));
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([verseTake, periTake]));
    vi.mocked(repo.listByChapter).mockResolvedValue(ok([periUnit]));
    vi.mocked(takesRepo.listTakesByRecordingIds).mockResolvedValue(ok([verseTake, periTake]));

    const unit = await getRecording(12, 3401);
    const list = await listChapterRecordings(12, 9, 40, 1);

    expect(unit.ok && list.ok).toBe(true);
    if (!unit.ok || !list.ok) {
      return;
    }

    expect(list.data.items).toHaveLength(1);
    expect(list.data.items[0]).toEqual(unit.data);
    expect(list.data.hasConflict).toBe(false);
  });

  it('preserves overlap conflictStatus on chapter list without inventing playback', async () => {
    const conflicted: VerseAudioRecord = {
      ...record,
      id: 2,
      bibleTextId: 3402,
      verseNumber: 4,
      conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      activeTakeId: 20,
    };
    const conflictTake: VerseAudioTakeRecord = {
      ...take,
      id: 20,
      recordingId: 2,
      contentHash: pericopeHash,
    };

    vi.mocked(repo.listByChapter).mockResolvedValue(ok([record, conflicted]));
    vi.mocked(takesRepo.listTakesByRecordingIds).mockResolvedValue(ok([verseTake, conflictTake]));

    const result = await listChapterRecordings(12, 9, 40, 1);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.hasConflict).toBe(true);
    expect(result.data.items[0]?.conflictStatus).toBe('clean');
    expect(result.data.items[1]?.conflictStatus).toBe('conflict');
    expect(result.data.items[1]?.activeTakeId).toBe(20);
    expect(result.data.items[1]?.downloadUrl).toBe(signedUrl(12, 3402, pericopeHash));
  });

  it('exposes chapter-inclusion / cross-chapter pericope coverage on the anchor chapter list', async () => {
    const cross: VerseAudioRecord = {
      ...record,
      granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
      startChapter: 1,
      startVerse: 3,
      endChapter: 2,
      endVerse: 4,
      activeTakeId: 20,
    };
    const crossTake: VerseAudioTakeRecord = {
      ...take,
      id: 20,
      contentHash: pericopeHash,
      granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
      startChapter: 1,
      startVerse: 3,
      endChapter: 2,
      endVerse: 4,
    };

    vi.mocked(repo.listByChapter).mockResolvedValue(ok([cross]));
    vi.mocked(takesRepo.listTakesByRecordingIds).mockResolvedValue(ok([crossTake]));

    const result = await listChapterRecordings(12, 9, 40, 1);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.items[0]).toMatchObject({
      bibleTextId: 3401,
      verseNumber: 3,
      granularity: 'pericope',
      startChapter: 1,
      startVerse: 3,
      endChapter: 2,
      endVerse: 4,
      activeTakeId: 20,
      downloadUrl: signedUrl(12, 3401, pericopeHash),
    });
    expect(repo.listByChapter).toHaveBeenCalledWith(12, 9, 40, 1);
  });

  it('propagates empty chapter list without inventing units', async () => {
    vi.mocked(repo.listByChapter).mockResolvedValue(ok([]));
    vi.mocked(takesRepo.listTakesByRecordingIds).mockResolvedValue(ok([]));

    const result = await listChapterRecordings(12, 9, 40, 1);

    expect(result).toEqual(ok({ items: [], hasConflict: false }));
  });

  it('propagates not-found without inventing unavailable payloads', async () => {
    vi.mocked(repo.get).mockResolvedValue(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));

    const result = await getRecording(12, 3401);

    expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
    expect(generateAudioDownloadUrl).not.toHaveBeenCalled();
  });
});

describe('selected-canonical empty takes + exact older active', () => {
  const olderHash = 'e'.repeat(64);
  const newerHash = 'f'.repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageRepo.getByIds).mockResolvedValue(ok([]));
    vi.mocked(generateAudioDownloadUrl).mockImplementation(async (key: string) => {
      return `https://r2.example/${key}?sig=x`;
    });
  });

  it.each([
    { label: 'null active', activeTakeId: null as number | null },
    { label: 'unmatched active', activeTakeId: 999 as number | null },
  ])('keeps takes:[] unavailable when $label', async ({ activeTakeId }) => {
    const unit: VerseAudioRecord = { ...record, activeTakeId };
    vi.mocked(repo.get).mockResolvedValue(ok(unit));
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([]));

    const result = await getRecording(12, 3401);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.takes).toEqual([]);
    expect(result.data.activeTakeId).toBe(activeTakeId);
    expect(result.data.downloadUrl).toBeNull();
    expect(generateAudioDownloadUrl).not.toHaveBeenCalled();
  });

  it('selects older non-last active take over newer different-granularity take', async () => {
    const olderVerse: VerseAudioTakeRecord = {
      ...take,
      id: 10,
      contentHash: olderHash,
      granularity: VERSE_AUDIO_GRANULARITY.VERSE,
      startChapter: null,
      startVerse: null,
      endChapter: null,
      endVerse: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    };
    const newerPericope: VerseAudioTakeRecord = {
      ...take,
      id: 20,
      contentHash: newerHash,
      sizeBytes: 8,
      durationSeconds: 40,
      granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
      startChapter: 1,
      startVerse: 3,
      endChapter: 1,
      endVerse: 8,
      createdAt: new Date('2026-07-03T00:00:00Z'),
      updatedAt: new Date('2026-07-03T00:00:00Z'),
    };
    const unit: VerseAudioRecord = {
      ...record,
      activeTakeId: 10,
      granularity: VERSE_AUDIO_GRANULARITY.VERSE,
      startChapter: null,
      startVerse: null,
      endChapter: null,
      endVerse: null,
    };

    vi.mocked(repo.get).mockResolvedValue(ok(unit));
    // Newer take last in array — invent-take would wrongly pick it.
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([olderVerse, newerPericope]));

    const result = await getRecording(12, 3401);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.activeTakeId).toBe(10);
    expect(result.data.granularity).toBe('verse');
    expect(result.data).toMatchObject({
      startChapter: 1,
      startVerse: 3,
      endChapter: 1,
      endVerse: 3,
    });
    expect(result.data.downloadUrl).toBe(signedUrl(12, 3401, olderHash));
    expect(result.data.downloadUrl).toBe(result.data.takes[0]?.downloadUrl);
    expect(result.data.downloadUrl).not.toBe(signedUrl(12, 3401, newerHash));
    expect(result.data.takes[1]?.contentHash).toBe(newerHash);
    expect(result.data.takes[1]?.granularity).toBe('pericope');
  });
});
