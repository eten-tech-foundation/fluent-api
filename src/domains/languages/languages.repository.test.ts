import { beforeEach, describe, expect, it, vi } from 'vitest';

import { languages } from '@/db/schema';

import type { DblLanguageUpsertInput } from './languages.repository';

import { upsertFromDbl } from './languages.repository';

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = { insert: vi.fn() };
  const mockDb = { transaction: vi.fn() };
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

  it('targets langCodeIso6393 as the conflict column', async () => {
    const { onConflictDoUpdateFn } = mockUpsertResult([{ wasInsert: true }]);

    await upsertFromDbl([sampleRow]);

    expect(onConflictDoUpdateFn).toHaveBeenCalledWith(
      expect.objectContaining({ target: languages.langCodeIso6393 })
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
