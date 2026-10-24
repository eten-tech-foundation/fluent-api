import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppPolicyUser } from '@/lib/types';

import { deleteVerseAudio } from '@/lib/audio-storage';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ok } from '@/lib/types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import * as repo from './verse-audio.repository';
import { deleteTake } from './verse-audio.service';
import { record, take } from './verse-audio.test-fixtures';

vi.mock('@/lib/audio-storage', () => ({
  audioBlobName: vi.fn(
    (unitId: number, textId: number, hash: string) => `unit-${unitId}/text-${textId}/${hash}`
  ),
  audioBucket: vi.fn(() => 'verse-audio'),
  deleteVerseAudio: vi.fn(async () => {}),
  generateAudioDownloadUrl: vi.fn(async (key: string) => `https://r2.example/${key}?sig=x`),
}));

vi.mock('./storage-objects.repository', () => ({
  getById: vi.fn(),
  getByIds: vi.fn(),
  markDeleted: vi.fn(),
}));

vi.mock('./verse-audio.repository', () => ({
  get: vi.fn(),
}));

vi.mock('./verse-audio-takes.repository', () => ({
  deleteTakeAndPromote: vi.fn(),
  getTakeById: vi.fn(),
  listTakesByRecordingIds: vi.fn(),
  listTakesForRecording: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const scope = { orgId: 1, projectId: 1 };

function actor(id: number, permissions: string[] = [PERMISSIONS.CONTENT_UPDATE]): AppPolicyUser {
  return { id, grants: [{ orgId: 1, projectId: 1, permissions: new Set(permissions) }] } as never;
}

const otherTake = {
  ...take,
  id: 11,
  uploadedBy: 8,
  contentHash: 'other-hash',
  storageObjectId: 56,
};

const input = (overrides: Partial<Parameters<typeof deleteTake>[0]> = {}) => ({
  projectUnitId: 12,
  bibleTextId: 3401,
  takeId: 11,
  actor: actor(8),
  scope,
  ...overrides,
});

describe('deleteTake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repo.get).mockResolvedValue(ok(record));
    vi.mocked(takesRepo.getTakeById).mockResolvedValue(ok(otherTake));
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take]));
    vi.mocked(storageRepo.getById).mockResolvedValue(
      ok({ bucket: 'verse-audio', createdAt: new Date(), deletedAt: null, id: 56, key: 'k-56' })
    );
    vi.mocked(storageRepo.getByIds).mockResolvedValue(ok([]));
    vi.mocked(storageRepo.markDeleted).mockResolvedValue(ok(undefined));
    vi.mocked(takesRepo.deleteTakeAndPromote).mockResolvedValue(
      ok({ storageObjectId: 56, contentHash: 'other-hash', activeTakeId: 10, wasActive: false })
    );
  });

  it('lets the uploader delete their own non-active take and keeps the active take', async () => {
    const result = await deleteTake(input());

    expect(takesRepo.deleteTakeAndPromote).toHaveBeenCalledWith(1, 11);
    expect(deleteVerseAudio).toHaveBeenCalledWith('k-56');
    expect(storageRepo.markDeleted).toHaveBeenCalledWith(56);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.activeTakeId).toBe(10);
      expect(result.data.takes.map((t) => t.id)).toEqual([10]);
    }
  });

  it('lets a content:assign holder delete another user take', async () => {
    const result = await deleteTake(input({ actor: actor(99, [PERMISSIONS.CONTENT_ASSIGN]) }));

    expect(result.ok).toBe(true);
    expect(takesRepo.deleteTakeAndPromote).toHaveBeenCalled();
  });

  it('returns FORBIDDEN for a non-owner without content:assign', async () => {
    const result = await deleteTake(input({ actor: actor(99) }));

    expect(result).toEqual(err(ErrorCode.FORBIDDEN));
    expect(takesRepo.deleteTakeAndPromote).not.toHaveBeenCalled();
    expect(deleteVerseAudio).not.toHaveBeenCalled();
  });

  it('does not honour content:assign granted on a different project', async () => {
    const foreign = {
      id: 99,
      grants: [{ orgId: 1, projectId: 2, permissions: new Set([PERMISSIONS.CONTENT_ASSIGN]) }],
    } as never;

    const result = await deleteTake(input({ actor: foreign }));

    expect(result).toEqual(err(ErrorCode.FORBIDDEN));
  });

  it('returns TAKE_NOT_FOUND for an unknown take', async () => {
    vi.mocked(takesRepo.getTakeById).mockResolvedValue(err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND));

    const result = await deleteTake(input());

    expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND));
  });

  it('returns TAKE_NOT_FOUND for a take that belongs to another unit', async () => {
    vi.mocked(takesRepo.getTakeById).mockResolvedValue(ok({ ...otherTake, recordingId: 2 }));

    const result = await deleteTake(input());

    expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND));
    expect(takesRepo.deleteTakeAndPromote).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the unit has no recording', async () => {
    vi.mocked(repo.get).mockResolvedValue(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));

    const result = await deleteTake(input());

    expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
  });

  it('returns the promoted active take after deleting the active take', async () => {
    vi.mocked(takesRepo.getTakeById).mockResolvedValue(ok({ ...take, uploadedBy: 8 }));
    vi.mocked(takesRepo.deleteTakeAndPromote).mockResolvedValue(
      ok({ storageObjectId: 55, contentHash: take.contentHash, activeTakeId: 11, wasActive: true })
    );
    vi.mocked(repo.get).mockResolvedValue(ok({ ...record, activeTakeId: 11, versionToken: 2 }));
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([otherTake]));

    const result = await deleteTake(input({ takeId: 10 }));

    expect(takesRepo.deleteTakeAndPromote).toHaveBeenCalledWith(1, 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.activeTakeId).toBe(11);
      expect(result.data.versionToken).toBe(2);
    }
  });

  it('still succeeds when the blob delete fails (left for the reclaim sweep)', async () => {
    vi.mocked(deleteVerseAudio).mockRejectedValueOnce(new Error('r2 down'));

    const result = await deleteTake(input());

    expect(result.ok).toBe(true);
    expect(storageRepo.markDeleted).not.toHaveBeenCalled();
  });
});
