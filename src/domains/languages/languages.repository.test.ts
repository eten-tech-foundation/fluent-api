import { beforeEach, describe, expect, it, vi } from 'vitest';

import { languages } from '@/db/schema';

import type { DblLanguageUpsertInput } from './languages.repository';

import { getAll, upsertFromDbl } from './languages.repository';

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = { insert: vi.fn() };
  const mockDb = { select: vi.fn(), transaction: vi.fn() };
  return { mockDb, mockTx };
});

vi.mock('@/db', () => ({ db: mockDb }));

function mockUpsertResult(rows: { wasInsert: boolean }[]) {
  const valuesFn = vi.fn();
  mockTx.insert.mockReturnValue({ values: valuesFn });
  const onConflictDoUpdateFn = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(rows),
  });
  valuesFn.mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateFn });
  return { valuesFn, onConflictDoUpdateFn };
}

const sampleRow: DblLanguageUpsertInput = {
  langCodeIso6393: 'eng',
  langName: 'English',
  langNameLocalized: 'English',
  scriptDirection: 'ltr',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockTx) => Promise<void>) => {
    await callback(mockTx);
  });
});

describe('languages.getAll', () => {
  it('returns all languages without a where clause when updatedAfter is omitted', async () => {
    const rows = [{ id: 1, langName: 'English' }];
    const fromFn = vi.fn().mockResolvedValue(rows);
    mockDb.select.mockReturnValue({ from: fromFn });

    const result = await getAll();

    expect(result).toEqual({ ok: true, data: rows });
    expect(fromFn).toHaveBeenCalled();
    expect(fromFn).toHaveBeenCalledWith(expect.anything());
  });

  it('applies updatedAfter filter via where when provided', async () => {
    const rows: unknown[] = [];
    const whereFn = vi.fn().mockResolvedValue(rows);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    mockDb.select.mockReturnValue({ from: fromFn });

    const updatedAfter = new Date('2025-01-01T00:00:00.000Z');
    const result = await getAll(updatedAfter);

    expect(result).toEqual({ ok: true, data: [] });
    expect(whereFn).toHaveBeenCalledOnce();
  });
});

describe('upsertFromDbl', () => {
  it('returns ok immediately for an empty rows array without touching the DB', async () => {
    const result = await upsertFromDbl([]);

    expect(result).toEqual({ ok: true, data: { inserted: 0, updated: 0 } });
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('counts a freshly inserted row via the xmax=0 marker', async () => {
    mockUpsertResult([{ wasInsert: true }]);

    const result = await upsertFromDbl([sampleRow]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ inserted: 1, updated: 0 });
    }
  });

  it('counts a conflict-path row as updated', async () => {
    mockUpsertResult([{ wasInsert: false }]);

    const result = await upsertFromDbl([sampleRow]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ inserted: 0, updated: 1 });
    }
  });

  it('tallies a mixed batch of inserts and updates correctly', async () => {
    mockUpsertResult([{ wasInsert: true }, { wasInsert: false }, { wasInsert: true }]);

    const result = await upsertFromDbl([
      sampleRow,
      { ...sampleRow, langCodeIso6393: 'spa' },
      { ...sampleRow, langCodeIso6393: 'fra' },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ inserted: 2, updated: 1 });
    }
  });

  it('targets langCodeIso6393 as the conflict column and sets conditional updatedAt', async () => {
    const { onConflictDoUpdateFn } = mockUpsertResult([{ wasInsert: true }]);

    await upsertFromDbl([sampleRow]);

    expect(onConflictDoUpdateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        target: languages.langCodeIso6393,
        set: expect.objectContaining({
          updatedAt: expect.anything(),
        }),
      })
    );
  });

  it('returns err(INTERNAL_ERROR) when the transaction throws', async () => {
    mockDb.transaction.mockRejectedValueOnce(new Error('connection lost'));

    const result = await upsertFromDbl([sampleRow]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL_ERROR');
    }
  });
});
