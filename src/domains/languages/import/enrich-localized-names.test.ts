import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enrichLocalizedNames } from './enrich-localized-names';

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = { update: vi.fn() };
  const mockDb = { select: vi.fn(), transaction: vi.fn() };
  return { mockDb, mockTx };
});

vi.mock('@/db', () => ({ db: mockDb }));

function mockExistingLanguages(
  rows: { id: number; code: string | null; localized: string | null }[]
) {
  mockDb.select.mockReturnValue({ from: vi.fn().mockResolvedValue(rows) });
}

function mockUpdateChain(returning: { id: number }[] = [{ id: 1 }]) {
  const returningFn = vi.fn().mockResolvedValue(returning);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  mockTx.update.mockReturnValue({ set: setFn });
  return { setFn, whereFn, returningFn };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockTx) => Promise<void>) => {
    await callback(mockTx);
  });
});

describe('enrichLocalizedNames', () => {
  it('throws when required columns are missing', async () => {
    mockExistingLanguages([]);
    await expect(enrichLocalizedNames('Foo,Bar\n1,2\n')).rejects.toThrow(/missing required/i);
  });

  it('throws instead of truncating a localized name over 255 characters', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: null }]);
    const longName = 'a'.repeat(256);
    await expect(enrichLocalizedNames(`ISO_639,Print_Name\naaa,${longName}\n`)).rejects.toThrow(
      /exceeds 255 characters/
    );
  });

  it('counts code points correctly for limits, accepting a 255 code point string with emojis', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: null }]);
    mockUpdateChain();

    // An emoji takes 2 code units. 255 emojis = 510 code units, but 255 code points.
    const longName = '🌍'.repeat(255);
    const summary = await enrichLocalizedNames(`ISO_639,Print_Name\naaa,${longName}\n`);

    expect(summary.enriched).toBe(1);
  });

  it('sets the localized name for a matching language with none set yet', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: null }]);
    const { setFn, whereFn } = mockUpdateChain();

    const summary = await enrichLocalizedNames('ISO_639,Print_Name\naaa,Autonym One\n');

    expect(summary.enriched).toBe(1);
    expect(setFn).toHaveBeenCalledWith({ langNameLocalized: 'Autonym One' });
    expect(whereFn).toHaveBeenCalled();
  });

  it('does not overwrite a language that already has a localized name', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: 'Existing Autonym' }]);
    mockUpdateChain();

    const summary = await enrichLocalizedNames('ISO_639,Print_Name\naaa,New Autonym\n');

    expect(summary.enriched).toBe(0);
    expect(summary.skippedAlreadySet).toBe(1);
    expect(mockTx.update).not.toHaveBeenCalled();
  });

  it('normalizes the incoming code to lowercase before lookup', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: null }]);
    const { setFn, whereFn } = mockUpdateChain();

    const summary = await enrichLocalizedNames('ISO_639,Print_Name\nAAA,Autonym One\n');

    expect(summary.enriched).toBe(1);
    expect(setFn).toHaveBeenCalledWith({ langNameLocalized: 'Autonym One' });
    expect(whereFn).toHaveBeenCalled();
  });

  it('treats empty string as an already set value (strict null check)', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: '' }]);
    mockUpdateChain();

    const summary = await enrichLocalizedNames('ISO_639,Print_Name\naaa,New Autonym\n');

    expect(summary.enriched).toBe(0);
    expect(summary.skippedAlreadySet).toBe(1);
    expect(mockTx.update).not.toHaveBeenCalled();
  });

  it('handles a stale concurrent update by checking the returning clause', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: null }]);
    mockUpdateChain([]); // Update returns no rows, meaning it was modified concurrently

    const summary = await enrichLocalizedNames('ISO_639,Print_Name\naaa,New Autonym\n');

    expect(summary.enriched).toBe(0);
    expect(summary.skippedAlreadySet).toBe(1);
  });

  it('counts a code with no matching language row as skippedNoMatch', async () => {
    mockExistingLanguages([]);
    mockUpdateChain();

    const summary = await enrichLocalizedNames('ISO_639,Print_Name\nzzz,Unknown Language\n');

    expect(summary.skippedNoMatch).toBe(1);
    expect(mockTx.update).not.toHaveBeenCalled();
  });

  it('only enriches once when the same code appears twice in the file', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: null }]);
    const { setFn } = mockUpdateChain();

    const summary = await enrichLocalizedNames(
      'ISO_639,Print_Name\naaa,First Autonym\naaa,Second Autonym\n'
    );

    expect(summary.enriched).toBe(1);
    expect(setFn).toHaveBeenCalledTimes(1);
    expect(setFn).toHaveBeenCalledWith({ langNameLocalized: 'First Autonym' });
  });

  it('counts malformed codes as skippedInvalid', async () => {
    mockExistingLanguages([{ id: 1, code: 'aaa', localized: null }]);
    mockUpdateChain();

    const summary = await enrichLocalizedNames('ISO_639,Print_Name\n123,Autonym\na-b,Autonym\n');

    expect(summary.skippedInvalid).toBe(2);
    expect(summary.enriched).toBe(0);
    expect(mockTx.update).not.toHaveBeenCalled();
  });

  it('matches existing DB codes case-insensitively', async () => {
    mockExistingLanguages([{ id: 1, code: 'AAA', localized: null }]);
    const { setFn } = mockUpdateChain();

    const summary = await enrichLocalizedNames('ISO_639,Print_Name\naaa,Autonym One\n');

    expect(summary.enriched).toBe(1);
    expect(setFn).toHaveBeenCalledWith({ langNameLocalized: 'Autonym One' });
  });
});
