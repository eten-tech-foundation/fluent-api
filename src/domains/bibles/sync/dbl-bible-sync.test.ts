import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Language } from '@/domains/languages/languages.types';
import type { DblClient } from '@/lib/services/dbl/dbl.client';
import type { DblBibleSummary } from '@/lib/services/dbl/dbl.types';

import { ErrorCode, ok } from '@/lib/types';

import type { DblBibleUpsertSummary } from '../bibles.repository';

import { syncBiblesFromDbl } from './dbl-bible-sync';

const { mockUpsertFromDbl, mockGetAllBibles, mockGetAllLanguages } = vi.hoisted(() => ({
  mockUpsertFromDbl: vi.fn(),
  mockGetAllBibles: vi.fn(),
  mockGetAllLanguages: vi.fn(),
}));

vi.mock('../bibles.repository', () => ({
  upsertFromDbl: mockUpsertFromDbl,
  getAll: mockGetAllBibles,
}));

vi.mock('@/domains/languages/languages.repository', () => ({
  getAll: mockGetAllLanguages,
}));

function bible(overrides: {
  id: string;
  langId: string;
  abbreviation?: string;
  abbreviationLocal?: string;
}): DblBibleSummary {
  return {
    id: overrides.id,
    abbreviation: overrides.abbreviation ?? overrides.id.toUpperCase(),
    abbreviationLocal: overrides.abbreviationLocal,
    name: `${overrides.id} Bible`,
    nameLocal: `${overrides.id} Bible`,
    language: {
      id: overrides.langId,
      name: 'Test',
      nameLocal: 'Test',
      script: 'Latin',
      scriptDirection: 'LTR',
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

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertFromDbl.mockResolvedValue(ok({ inserted: 0, updated: 0 } as DblBibleUpsertSummary));
  mockGetAllBibles.mockResolvedValue(ok([]));
  mockGetAllLanguages.mockResolvedValue(ok([{ id: 100, langCodeIso6393: 'eng' }] as Language[]));
});

describe('syncBiblesFromDbl', () => {
  it('propagates a client error without calling repositories', async () => {
    const client = {
      ...fakeClient([]),
      getBibles: vi
        .fn()
        .mockResolvedValue({ ok: false, error: { code: ErrorCode.DBL_NOT_CONFIGURED } }),
    } as unknown as DblClient;

    const result = await syncBiblesFromDbl(client);

    expect(result.ok).toBe(false);
    expect(mockGetAllLanguages).not.toHaveBeenCalled();
    expect(mockUpsertFromDbl).not.toHaveBeenCalled();
  });

  it('skips bibles if the language is missing from our database', async () => {
    const client = fakeClient([bible({ id: 'spa-bible', langId: 'spa' })]); // 'spa' not in our mock DB

    const result = await syncBiblesFromDbl(client);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skippedMissingLanguage).toBe(1);
      expect(result.data.inserted).toBe(0);
    }
    expect(mockUpsertFromDbl).toHaveBeenCalledWith([]);
  });

  it('passes all bibles with known languages through to upsert', async () => {
    mockUpsertFromDbl.mockResolvedValue(ok({ inserted: 3, updated: 0 }));
    const client = fakeClient([
      bible({ id: 'b1', langId: 'eng' }),
      bible({ id: 'b2', langId: 'eng' }),
      bible({ id: 'b3', langId: 'eng' }),
    ]);

    const result = await syncBiblesFromDbl(client);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.totalBibles).toBe(3);
      expect(result.data.skippedMissingLanguage).toBe(0);
    }
    expect(mockUpsertFromDbl).toHaveBeenCalledWith([
      expect.objectContaining({ externalId: 'b1' }),
      expect.objectContaining({ externalId: 'b2' }),
      expect.objectContaining({ externalId: 'b3' }),
    ]);
  });

  it('maps valid bibles to UpsertInput rows and calls upsertFromDbl', async () => {
    mockUpsertFromDbl.mockResolvedValue(ok({ inserted: 2, updated: 0 }));
    const client = fakeClient([
      bible({ id: 'b1', langId: 'eng', abbreviationLocal: 'B1L' }),
      bible({ id: 'b2', langId: 'eng', abbreviation: 'B2A', abbreviationLocal: undefined }),
    ]);

    const result = await syncBiblesFromDbl(client);

    expect(result.ok).toBe(true);
    expect(mockUpsertFromDbl).toHaveBeenCalledWith([
      expect.objectContaining({ languageId: 100, externalId: 'b1', abbreviation: 'B1L' }),
      expect.objectContaining({ languageId: 100, externalId: 'b2', abbreviation: 'B2A' }),
    ]);
  });
});
