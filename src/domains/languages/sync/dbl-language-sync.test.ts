import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DblClient } from '@/lib/services/dbl/dbl.client';
import type { DblBibleSummary } from '@/lib/services/dbl/dbl.types';

import { ErrorCode, ok } from '@/lib/types';

import type { DblLanguageUpsertSummary } from '../languages.repository';

import { syncLanguagesFromDbl } from './dbl-language-sync';

const { mockUpsertFromDbl } = vi.hoisted(() => ({
  mockUpsertFromDbl: vi.fn(),
}));

vi.mock('../languages.repository', () => ({
  upsertFromDbl: mockUpsertFromDbl,
}));

function bible(overrides: {
  id: string;
  langId: string;
  langName?: string;
  langNameLocal?: string | null;
  scriptDirection?: string;
}): DblBibleSummary {
  return {
    id: overrides.id,
    abbreviation: overrides.id.toUpperCase(),
    abbreviationLocal: overrides.id.toUpperCase(),
    name: `${overrides.langName ?? overrides.langId} Bible`,
    nameLocal: `${overrides.langName ?? overrides.langId} Bible`,
    language: {
      id: overrides.langId,
      name: overrides.langName ?? overrides.langId,
      nameLocal: overrides.langNameLocal ?? overrides.langName ?? overrides.langId,
      script: 'Latin',
      scriptDirection: overrides.scriptDirection ?? 'LTR',
    },
  } as DblBibleSummary;
}

function fakeClient(bibles: DblBibleSummary[]): DblClient {
  return {
    getBibles: vi.fn().mockResolvedValue(ok(bibles)),
    getBible: vi.fn(),
    getBooks: vi.fn(),
    getBook: vi.fn(),
    getChapters: vi.fn(),
    getChapter: vi.fn(),
    getVerses: vi.fn(),
    getVerse: vi.fn(),
    getPassage: vi.fn(),
    getAudioChapter: vi.fn(),
  };
}

function mockUpsertOk(summary: DblLanguageUpsertSummary) {
  mockUpsertFromDbl.mockResolvedValue(ok(summary));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('syncLanguagesFromDbl', () => {
  it('propagates a DBL_NOT_CONFIGURED error without calling upsertFromDbl', async () => {
    const client: DblClient = {
      getBibles: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: ErrorCode.DBL_NOT_CONFIGURED, message: 'x' },
      }),
      getBible: vi.fn(),
      getBooks: vi.fn(),
      getBook: vi.fn(),
      getChapters: vi.fn(),
      getChapter: vi.fn(),
      getVerses: vi.fn(),
      getVerse: vi.fn(),
      getPassage: vi.fn(),
      getAudioChapter: vi.fn(),
    };

    const result = await syncLanguagesFromDbl(client);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.DBL_NOT_CONFIGURED);
    }
    expect(mockUpsertFromDbl).not.toHaveBeenCalled();
  });

  it('dedupes multiple Bibles in the same language into a single upsert row', async () => {
    mockUpsertOk({ inserted: 1, updated: 0 });
    const client = fakeClient([
      bible({ id: 'kjv', langId: 'eng', langName: 'English' }),
      bible({ id: 'niv', langId: 'eng', langName: 'English' }),
    ]);

    const result = await syncLanguagesFromDbl(client);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.totalBibles).toBe(2);
      expect(result.data.uniqueLanguages).toBe(1);
    }
    expect(mockUpsertFromDbl).toHaveBeenCalledWith([
      expect.objectContaining({ langCodeIso6393: 'eng', langName: 'English' }),
    ]);
  });

  it('keeps the first Bible seen for a given language code', async () => {
    mockUpsertOk({ inserted: 1, updated: 0 });
    const client = fakeClient([
      bible({ id: 'first', langId: 'eng', langName: 'First Name' }),
      bible({ id: 'second', langId: 'eng', langName: 'Second Name' }),
    ]);

    await syncLanguagesFromDbl(client);

    expect(mockUpsertFromDbl).toHaveBeenCalledWith([
      expect.objectContaining({ langName: 'First Name' }),
    ]);
  });

  it('maps scriptDirection RTL/LTR to the lowercase DB enum, case-insensitively', async () => {
    mockUpsertOk({ inserted: 2, updated: 0 });
    const client = fakeClient([
      bible({ id: 'urdu-bible', langId: 'urd', langName: 'Urdu', scriptDirection: 'RTL' }),
      bible({ id: 'eng-bible', langId: 'eng', langName: 'English', scriptDirection: 'ltr' }),
    ]);

    await syncLanguagesFromDbl(client);

    expect(mockUpsertFromDbl).toHaveBeenCalledWith([
      expect.objectContaining({ langCodeIso6393: 'urd', scriptDirection: 'rtl' }),
      expect.objectContaining({ langCodeIso6393: 'eng', scriptDirection: 'ltr' }),
    ]);
  });

  it('skips a Bible whose language code is not a valid ISO 639-3 code', async () => {
    mockUpsertOk({ inserted: 1, updated: 0 });
    const client = fakeClient([
      bible({ id: 'ok-bible', langId: 'eng', langName: 'English' }),
      bible({ id: 'bad-bible', langId: 'not-a-code', langName: 'Mystery' }),
    ]);

    const result = await syncLanguagesFromDbl(client);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skippedInvalid).toBe(1);
      expect(result.data.uniqueLanguages).toBe(1);
    }
  });

  it('skips a Bible whose language name exceeds the 255 character field limit', async () => {
    mockUpsertOk({ inserted: 0, updated: 0 });
    const client = fakeClient([bible({ id: 'x', langId: 'eng', langName: 'a'.repeat(256) })]);

    const result = await syncLanguagesFromDbl(client);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skippedInvalid).toBe(1);
      expect(result.data.uniqueLanguages).toBe(0);
    }
    expect(mockUpsertFromDbl).toHaveBeenCalledWith([]);
  });

  it('propagates an INTERNAL_ERROR from upsertFromDbl', async () => {
    mockUpsertFromDbl.mockResolvedValue({
      ok: false,
      error: { code: ErrorCode.INTERNAL_ERROR, message: 'db down' },
    });
    const client = fakeClient([bible({ id: 'x', langId: 'eng', langName: 'English' })]);

    const result = await syncLanguagesFromDbl(client);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    }
  });

  it('surfaces inserted/updated counts from upsertFromDbl in the summary', async () => {
    mockUpsertOk({ inserted: 3, updated: 5 });
    const client = fakeClient([bible({ id: 'x', langId: 'eng', langName: 'English' })]);

    const result = await syncLanguagesFromDbl(client);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.inserted).toBe(3);
      expect(result.data.updated).toBe(5);
    }
  });
});
