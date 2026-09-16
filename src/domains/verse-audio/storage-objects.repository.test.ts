import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';

import { reclaimOrphanIfUnreferenced } from './storage-objects.repository';

vi.mock('@/db', () => ({
  db: { transaction: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}));

function selectForUpdate(result: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        for: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function selectRecheck(result: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function transactionWith(lockResult: unknown[], recheckResult: unknown[]) {
  const returning = vi.fn().mockResolvedValue([{ id: 7 }]);
  const tx = {
    select: vi
      .fn()
      .mockReturnValueOnce(selectForUpdate(lockResult))
      .mockReturnValueOnce(selectRecheck(recheckResult)),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning }),
    }),
  };
  vi.mocked(db.transaction).mockImplementation(async (callback: any) => callback(tx));
  return { returning, tx };
}

describe('reclaimOrphanIfUnreferenced', () => {
  const object = {
    id: 7,
    bucket: 'verse-audio',
    key: 'unit-1/text-2/hash',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('locks by id before rechecking orphan predicates', async () => {
    const { tx } = transactionWith([object], []);
    const deleteObject = vi.fn();

    const result = await reclaimOrphanIfUnreferenced(7, 60_000, deleteObject);

    expect(result).toEqual({ ok: true, data: false });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
  });

  it('deletes the object and row only after the locked recheck succeeds', async () => {
    const { returning, tx } = transactionWith([object], [object]);
    const deleteObject = vi.fn().mockResolvedValue(undefined);

    const result = await reclaimOrphanIfUnreferenced(7, 60_000, deleteObject);

    expect(deleteObject).toHaveBeenCalledWith(object);
    expect(tx.delete).toHaveBeenCalled();
    expect(returning).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: true });
  });
});
