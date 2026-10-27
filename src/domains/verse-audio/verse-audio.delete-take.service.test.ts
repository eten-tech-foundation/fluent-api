import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Permission } from '@/lib/permissions';
import type { AppPolicyUser } from '@/lib/types';

import env from '@/env';
import { deleteVerseAudio } from '@/lib/audio-storage';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ok } from '@/lib/types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import * as repo from './verse-audio.repository';
import { deleteTake } from './verse-audio.service';
import { record, take } from './verse-audio.test-fixtures';
import { VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

vi.mock('@/db/transaction', () => ({
  runInTransaction: async <T>(work: (tx: unknown) => Promise<T>) => work({}),
}));

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
  reclaimOrphanIfUnreferenced: vi.fn(),
}));

vi.mock('./verse-audio.repository', () => ({
  get: vi.fn(),
}));

vi.mock('./verse-audio-takes.repository', () => ({
  deleteTake: vi.fn(),
  getTakeById: vi.fn(),
  listTakesByRecordingIds: vi.fn(),
  listTakesForRecording: vi.fn(),
  lockRecording: vi.fn(),
  setActiveTake: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const scope = { orgId: 1, projectId: 1 };

function actor(
  id: number,
  permissions: Permission[] = [PERMISSIONS.CONTENT_UPDATE]
): AppPolicyUser {
  return { id, grants: [{ orgId: 1, projectId: 1, permissions: new Set(permissions) }] };
}

const otherTake = {
  ...take,
  id: 11,
  uploadedBy: 8,
  contentHash: 'other-hash',
  storageObjectId: 56,
  createdAt: new Date('2026-07-02T00:00:00Z'),
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
    vi.mocked(takesRepo.lockRecording).mockResolvedValue(
      ok({ id: 1, activeTakeId: 10, versionToken: 1 })
    );
    vi.mocked(takesRepo.deleteTake).mockResolvedValue(
      ok({ storageObjectId: 56, contentHash: 'other-hash' })
    );
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([take]));
    vi.mocked(takesRepo.setActiveTake).mockResolvedValue(ok({ applied: true }));
    vi.mocked(storageRepo.getById).mockResolvedValue(
      ok({ bucket: 'verse-audio', createdAt: new Date(), deletedAt: null, id: 56, key: 'k-56' })
    );
    vi.mocked(storageRepo.getByIds).mockResolvedValue(ok([]));
    vi.mocked(storageRepo.markDeleted).mockResolvedValue(ok(undefined));
    vi.mocked(storageRepo.reclaimOrphanIfUnreferenced).mockImplementation(
      async (_id, _grace, deleteObject) => {
        await deleteObject({
          bucket: 'verse-audio',
          createdAt: new Date(),
          deletedAt: null,
          id: 56,
          key: 'k-56',
        });
        return ok(true);
      }
    );
  });

  it('lets the uploader delete their own non-active take and keeps the active take', async () => {
    const result = await deleteTake(input());

    expect(takesRepo.lockRecording).toHaveBeenCalledWith(1, expect.anything());
    expect(takesRepo.deleteTake).toHaveBeenCalledWith(1, 11, expect.anything());
    expect(takesRepo.setActiveTake).not.toHaveBeenCalled();
    expect(storageRepo.reclaimOrphanIfUnreferenced).toHaveBeenCalledWith(
      56,
      env.AUDIO_RECLAIM_GRACE_MS,
      expect.any(Function)
    );
    expect(deleteVerseAudio).toHaveBeenCalledWith('k-56');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.activeTakeId).toBe(10);
      expect(result.data.takes.map((t) => t.id)).toEqual([10]);
    }
  });

  it('lets a content:assign holder delete another user take', async () => {
    const result = await deleteTake(input({ actor: actor(99, [PERMISSIONS.CONTENT_ASSIGN]) }));

    expect(result.ok).toBe(true);
    expect(takesRepo.deleteTake).toHaveBeenCalled();
  });

  it('returns FORBIDDEN for a non-owner without content:assign', async () => {
    const result = await deleteTake(input({ actor: actor(99) }));

    expect(result).toEqual(err(ErrorCode.FORBIDDEN));
    expect(takesRepo.deleteTake).not.toHaveBeenCalled();
    expect(deleteVerseAudio).not.toHaveBeenCalled();
  });

  it('does not honour content:assign granted on a different project', async () => {
    const foreign: AppPolicyUser = {
      id: 99,
      grants: [{ orgId: 1, projectId: 2, permissions: new Set([PERMISSIONS.CONTENT_ASSIGN]) }],
    };

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
    expect(takesRepo.deleteTake).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the unit has no recording', async () => {
    vi.mocked(repo.get).mockResolvedValue(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));

    const result = await deleteTake(input());

    expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
  });

  it('promotes the newest remaining take after deleting the active take (legacy omitted token)', async () => {
    vi.mocked(takesRepo.getTakeById).mockResolvedValue(ok({ ...take, uploadedBy: 8 }));
    vi.mocked(takesRepo.lockRecording).mockResolvedValue(
      ok({ id: 1, activeTakeId: 10, versionToken: 1 })
    );
    vi.mocked(takesRepo.deleteTake).mockResolvedValue(
      ok({ storageObjectId: 55, contentHash: take.contentHash })
    );
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([otherTake]));
    vi.mocked(repo.get)
      .mockResolvedValueOnce(ok(record))
      .mockResolvedValue(ok({ ...record, activeTakeId: 11, versionToken: 2 }));

    const result = await deleteTake(input({ takeId: 10 }));

    expect(takesRepo.setActiveTake).toHaveBeenCalledWith(1, otherTake, 1, expect.anything());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.activeTakeId).toBe(11);
      expect(result.data.versionToken).toBe(2);
    }
  });

  it('returns VERSION_CONFLICT when baseVersionToken is stale for an active take', async () => {
    vi.mocked(takesRepo.getTakeById).mockResolvedValue(ok({ ...take, uploadedBy: 8 }));
    vi.mocked(takesRepo.lockRecording).mockResolvedValue(
      ok({ id: 1, activeTakeId: 10, versionToken: 3 })
    );

    const result = await deleteTake(input({ takeId: 10, baseVersionToken: 1 }));

    expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT));
    expect(takesRepo.deleteTake).not.toHaveBeenCalled();
    expect(takesRepo.setActiveTake).not.toHaveBeenCalled();
  });

  it('promotes via CAS when baseVersionToken matches the locked active take', async () => {
    vi.mocked(takesRepo.getTakeById).mockResolvedValue(ok({ ...take, uploadedBy: 8 }));
    vi.mocked(takesRepo.lockRecording).mockResolvedValue(
      ok({ id: 1, activeTakeId: 10, versionToken: 2 })
    );
    vi.mocked(takesRepo.deleteTake).mockResolvedValue(
      ok({ storageObjectId: 55, contentHash: take.contentHash })
    );
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([otherTake]));
    vi.mocked(repo.get)
      .mockResolvedValueOnce(ok({ ...record, versionToken: 2 }))
      .mockResolvedValue(ok({ ...record, activeTakeId: 11, versionToken: 3 }));

    const result = await deleteTake(input({ takeId: 10, baseVersionToken: 2 }));

    expect(takesRepo.setActiveTake).toHaveBeenCalledWith(1, otherTake, 2, expect.anything());
    expect(result.ok).toBe(true);
  });

  it('keeps conflictStatus and skips coverage re-check when promoting under conflict', async () => {
    const conflicted = {
      ...record,
      conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
      versionToken: 4,
    };
    const remaining = {
      ...otherTake,
      granularity: 'pericope' as const,
      startChapter: 1,
      startVerse: 1,
      endChapter: 1,
      endVerse: 5,
    };
    vi.mocked(takesRepo.getTakeById).mockResolvedValue(ok({ ...take, uploadedBy: 8 }));
    vi.mocked(takesRepo.lockRecording).mockResolvedValue(
      ok({ id: 1, activeTakeId: 10, versionToken: 4 })
    );
    vi.mocked(takesRepo.deleteTake).mockResolvedValue(
      ok({ storageObjectId: 55, contentHash: take.contentHash })
    );
    vi.mocked(takesRepo.listTakesForRecording).mockResolvedValue(ok([remaining]));
    vi.mocked(repo.get)
      .mockResolvedValueOnce(ok(conflicted))
      .mockResolvedValue(
        ok({
          ...conflicted,
          activeTakeId: 11,
          versionToken: 5,
          granularity: remaining.granularity,
          startChapter: remaining.startChapter,
          startVerse: remaining.startVerse,
          endChapter: remaining.endChapter,
          endVerse: remaining.endVerse,
        })
      );

    const result = await deleteTake(input({ takeId: 10, baseVersionToken: 4 }));

    expect(takesRepo.setActiveTake).toHaveBeenCalledWith(1, remaining, 4, expect.anything());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.conflictStatus).toBe(VERSE_AUDIO_CONFLICT_STATUS.CONFLICT);
      expect(result.data.activeTakeId).toBe(11);
    }
  });

  it('still succeeds when the blob delete fails (left for the reclaim sweep)', async () => {
    vi.mocked(storageRepo.reclaimOrphanIfUnreferenced).mockResolvedValueOnce(
      err(ErrorCode.INTERNAL_ERROR)
    );

    const result = await deleteTake(input());

    expect(result.ok).toBe(true);
  });

  it('skips bucket delete when the storage row is still referenced', async () => {
    vi.mocked(storageRepo.reclaimOrphanIfUnreferenced).mockResolvedValueOnce(ok(false));

    const result = await deleteTake(input());

    expect(result.ok).toBe(true);
    expect(deleteVerseAudio).not.toHaveBeenCalled();
  });
});
