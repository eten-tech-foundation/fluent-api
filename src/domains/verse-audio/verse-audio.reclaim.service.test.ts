import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteVerseAudio } from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import { reclaimOrphanedStorageObjects } from './verse-audio.reclaim.service';

vi.mock('@/lib/audio-storage', () => ({
  deleteVerseAudio: vi.fn(async () => {}),
}));

vi.mock('./storage-objects.repository', () => ({
  findOrphans: vi.fn(),
  markDeleted: vi.fn(),
  reclaimOrphanIfUnreferenced: vi.fn(),
}));

vi.mock('./verse-audio-takes.repository', () => ({
  pruneSupersededTakes: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('verse-audio service', () => {
  describe('reclaimOrphanedStorageObjects', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(storageRepo.markDeleted).mockResolvedValue(ok(undefined));
      vi.mocked(storageRepo.reclaimOrphanIfUnreferenced).mockResolvedValue(ok(false));
      vi.mocked(deleteVerseAudio).mockResolvedValue(undefined);
      vi.mocked(takesRepo.pruneSupersededTakes).mockResolvedValue(ok(0));
    });

    const orphan = (id: number, key: string) => ({
      bucket: 'verse-audio',
      createdAt: new Date(),
      deletedAt: null,
      id,
      key,
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
      vi.mocked(takesRepo.pruneSupersededTakes).mockResolvedValue(ok(1));
      vi.mocked(storageRepo.findOrphans).mockResolvedValue(ok([]));

      const result = await reclaimOrphanedStorageObjects();

      expect(takesRepo.pruneSupersededTakes).toHaveBeenCalledWith(expect.any(Number));
      // The prune drops rows only. Deleting the blob here would race a concurrent
      // re-upload of the same bytes, which revives that very storage_objects row.
      expect(deleteVerseAudio).not.toHaveBeenCalled();
      expect(storageRepo.markDeleted).not.toHaveBeenCalled();
      expect(result).toEqual(ok(0));
    });

    it('still runs the orphan sweep when the take prune fails', async () => {
      vi.mocked(takesRepo.pruneSupersededTakes).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
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
