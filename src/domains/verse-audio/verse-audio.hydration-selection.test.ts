import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateAudioDownloadUrl } from '@/lib/audio-storage';
import { ok } from '@/lib/types';

import type { VerseAudioRecord, VerseAudioTakeRecord } from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import * as repo from './verse-audio.repository';
import { getRecording } from './verse-audio.service';
import { record, take } from './verse-audio.test-fixtures';
import { VERSE_AUDIO_GRANULARITY } from './verse-audio.types';

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

function signedUrl(projectUnitId: number, bibleTextId: number, contentHash: string): string {
  return `https://r2.example/unit-${projectUnitId}/text-${bibleTextId}/${contentHash}?sig=x`;
}

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
    vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([]));

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
    vi.mocked(repo.listTakesForRecording).mockResolvedValue(ok([olderVerse, newerPericope]));

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
