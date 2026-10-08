import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAll, upsertFromDbl } from './books.repository';

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = { insert: vi.fn(), select: vi.fn() };
  const mockDb = { select: vi.fn(), transaction: vi.fn() };
  return { mockDb, mockTx };
});

vi.mock('@/db', () => ({ db: mockDb }));

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockTx) => Promise<void>) => {
    await callback(mockTx);
  });
});

describe('books.getAll', () => {
  it('returns all books without a where clause when updatedAfter is omitted', async () => {
    const rows = [{ id: 1, code: 'GEN', eng_display_name: 'Genesis' }];
    const fromFn = vi.fn().mockResolvedValue(rows);
    mockDb.select.mockReturnValue({ from: fromFn });

    const result = await getAll();

    expect(result).toEqual({ ok: true, data: rows });
    expect(fromFn).toHaveBeenCalled();
  });

  it('applies updatedAfter filter via where when provided', async () => {
    const rows: unknown[] = [];
    const whereFn = vi.fn().mockResolvedValue(rows);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    mockDb.select.mockReturnValue({ from: fromFn });

    const result = await getAll(new Date('2025-06-01T12:00:00.000Z'));

    expect(result).toEqual({ ok: true, data: [] });
    expect(whereFn).toHaveBeenCalledOnce();
  });
});

describe('books.upsertFromDbl', () => {
  it('bumps updatedAt on conflict without overwriting eng_display_name', async () => {
    const onConflictDoUpdateFn = vi.fn().mockResolvedValue(undefined);
    const valuesFn = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateFn });
    mockTx.insert.mockReturnValueOnce({ values: valuesFn });

    const whereFn = vi.fn().mockResolvedValue([{ id: 1 }]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    mockTx.select.mockReturnValue({ from: fromFn });

    const linkValuesFn = vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    });
    mockTx.insert.mockReturnValueOnce({ values: linkValuesFn });

    const result = await upsertFromDbl(10, [{ code: 'GEN', eng_display_name: 'Génesis' }]);

    expect(result).toEqual({ ok: true, data: { linkedBooks: 1 } });
    expect(onConflictDoUpdateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ updatedAt: expect.anything() }),
      })
    );
    const setArg = onConflictDoUpdateFn.mock.calls[0][0].set;
    expect(setArg).not.toHaveProperty('eng_display_name');
  });
});
