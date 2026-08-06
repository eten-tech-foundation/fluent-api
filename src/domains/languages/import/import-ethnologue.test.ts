import { beforeEach, describe, expect, it, vi } from 'vitest';

import { languages } from '@/db/schema';

import { importEthnologueLanguages } from './import-ethnologue';

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = { insert: vi.fn() };
  const mockDb = { select: vi.fn(), transaction: vi.fn() };
  return { mockDb, mockTx };
});

vi.mock('@/db', () => ({ db: mockDb }));

function mockExistingCodes(codes: string[]) {
  mockDb.select.mockReturnValue({
    from: vi.fn().mockResolvedValue(codes.map((code) => ({ code }))),
  });
}

function mockInsertResult(rows: { id: number; scriptDirection: 'ltr' | 'rtl' }[]) {
  const valuesFn = vi.fn();
  mockTx.insert.mockReturnValue({ values: valuesFn });
  valuesFn.mockReturnValue({
    onConflictDoNothing: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  });
  return valuesFn;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockTx) => Promise<void>) => {
    await callback(mockTx);
  });
});

describe('importEthnologueLanguages', () => {
  it('throws when required columns are missing', async () => {
    await expect(importEthnologueLanguages('Foo,Bar\n1,2\n')).rejects.toThrow(/missing required/i);
  });

  it('throws instead of truncating a name over 255 characters', async () => {
    const longName = 'a'.repeat(256);
    await expect(importEthnologueLanguages(`LangID,Name\naaa,${longName}\n`)).rejects.toThrow(
      /exceeds 255 characters/
    );
  });

  it('skips rows with malformed codes and still imports valid ones, normalizing uppercase', async () => {
    mockExistingCodes([]);
    const valuesFn = mockInsertResult([{ id: 1, scriptDirection: 'ltr' }]);

    const csv = 'LangID,Name\ntoolong,Bad Code\n123,Numbers\na-b,Hyphen\nAAA,Uppercase Valid\n';
    const summary = await importEthnologueLanguages(csv);

    expect(summary.totalRows).toBe(4);
    expect(summary.skippedInvalid).toBe(3);
    expect(summary.inserted).toBe(1);

    expect(valuesFn).toHaveBeenCalledWith([
      expect.objectContaining({ langCodeIso6393: 'aaa', langName: 'Uppercase Valid' }),
    ]);
  });

  it('skips codes that already exist in the database', async () => {
    mockExistingCodes(['aaa']);
    mockInsertResult([{ id: 2, scriptDirection: 'ltr' }]);

    const csv = 'LangID,Name\naaa,Existing Language\nbbb,New Language\n';
    const summary = await importEthnologueLanguages(csv);

    expect(summary.skippedExisting).toBe(1);
    expect(summary.inserted).toBe(1);
  });

  it('keeps the first occurrence when the same code appears twice in the file', async () => {
    mockExistingCodes([]);
    const valuesFn = mockInsertResult([{ id: 1, scriptDirection: 'ltr' }]);

    const csv = 'LangID,Name\naaa,First Name\naaa,Second Name\n';
    await importEthnologueLanguages(csv);

    expect(valuesFn).toHaveBeenCalledWith([
      expect.objectContaining({ langCodeIso6393: 'aaa', langName: 'First Name' }),
    ]);
  });

  it('marks a language as RTL by explicit code', async () => {
    mockExistingCodes([]);
    mockInsertResult([{ id: 1, scriptDirection: 'rtl' }]);

    const csv = 'LangID,Name\nurd,Urdu\n';
    const summary = await importEthnologueLanguages(csv);

    expect(summary.rtlCount).toBe(1);
    expect(summary.ltrCount).toBe(0);
  });

  it('counts inserted/rtl/ltr from what the database actually returns, not what was attempted', async () => {
    mockExistingCodes([]);
    // Simulate a race: only one of the two attempted rows actually inserted.
    mockInsertResult([{ id: 1, scriptDirection: 'ltr' }]);

    const csv = 'LangID,Name\naaa,Language A\nbbb,Language B\n';
    const summary = await importEthnologueLanguages(csv);

    expect(summary.inserted).toBe(1);
    expect(summary.ltrCount).toBe(1);
  });

  it('passes the unique code column as the onConflictDoNothing target', async () => {
    mockExistingCodes([]);
    const valuesFn = mockInsertResult([{ id: 1, scriptDirection: 'ltr' }]);

    await importEthnologueLanguages('LangID,Name\naaa,Language A\n');

    const onConflictMock = valuesFn.mock.results[0].value.onConflictDoNothing;
    expect(onConflictMock).toHaveBeenCalledWith({ target: languages.langCodeIso6393 });
  });
  it('matches existing DB codes case-insensitively to prevent semantic duplicates', async () => {
    mockExistingCodes(['AAA']);
    mockInsertResult([]);

    const csv = 'LangID,Name\naaa,Language A\n';
    const summary = await importEthnologueLanguages(csv);

    expect(summary.skippedExisting).toBe(1);
    expect(summary.inserted).toBe(0);
  });
});
