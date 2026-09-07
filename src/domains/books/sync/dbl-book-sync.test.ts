import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bible } from '@/domains/bibles/bibles.types';
import type { DblClient } from '@/lib/services/dbl/dbl.client';
import type { DblBook } from '@/lib/services/dbl/dbl.types';

import { ErrorCode, ok } from '@/lib/types';

import * as booksRepo from '../books.repository';
import { syncAudioAvailability, syncBooksFromDbl } from './dbl-book-sync';

const { mockUpsertFromDbl, mockGetAllBibles } = vi.hoisted(() => ({
  mockUpsertFromDbl: vi.fn(),
  mockGetAllBibles: vi.fn(),
}));

vi.mock('../books.repository', () => ({
  upsertFromDbl: mockUpsertFromDbl,
  updateAudioAvailability: vi.fn(),
}));

vi.mock('@/domains/bibles/bibles.repository', () => ({
  getAll: mockGetAllBibles,
}));

function fakeClient(responses: Record<string, DblBook[]>): DblClient {
  return {
    getBooks: vi.fn().mockImplementation((bibleId: string) => {
      if (responses[bibleId]) return Promise.resolve(ok(responses[bibleId]));
      return Promise.resolve({ ok: false, error: { code: ErrorCode.INTERNAL_ERROR } });
    }),
    getBible: vi.fn(),
    getAudioBibleBooks: vi.fn(),
  } as unknown as DblClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertFromDbl.mockResolvedValue(ok({ linkedBooks: 2 }));
});

describe('syncBooksFromDbl', () => {
  it('propagates DB error if getAll bibles fails', async () => {
    mockGetAllBibles.mockResolvedValue({ ok: false, error: { code: ErrorCode.INTERNAL_ERROR } });

    const result = await syncBooksFromDbl(fakeClient({}));
    expect(result.ok).toBe(false);
  });

  it('processes each bible and links its books', async () => {
    mockGetAllBibles.mockResolvedValue(
      ok([
        { id: 1, externalId: 'b1', provider: 'dbl' },
        { id: 2, externalId: 'b2', provider: 'dbl' },
      ] as Bible[])
    );

    const client = fakeClient({
      b1: [{ id: 'GEN', name: 'Genesis', bibleId: 'b1', abbreviation: 'GEN', nameLong: 'Genesis' }],
      b2: [{ id: 'EXO', name: 'Exodus', bibleId: 'b2', abbreviation: 'EXO', nameLong: 'Exodus' }],
    });

    const result = await syncBooksFromDbl(client);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.totalBiblesProcessed).toBe(2);
      expect(result.data.totalBooksLinked).toBe(4); // 2 + 2 from mockUpsertFromDbl
    }

    expect(mockUpsertFromDbl).toHaveBeenCalledTimes(2);
    expect(mockUpsertFromDbl).toHaveBeenCalledWith(1, [
      { code: 'GEN', eng_display_name: 'Genesis' },
    ]);
    expect(mockUpsertFromDbl).toHaveBeenCalledWith(2, [
      { code: 'EXO', eng_display_name: 'Exodus' },
    ]);
  });
});

describe('syncAudioAvailability', () => {
  beforeEach(() => {
    vi.mocked(booksRepo.updateAudioAvailability).mockResolvedValue(ok({ updated: 1 }));
  });

  it('skips bibles without audio', async () => {
    mockGetAllBibles.mockResolvedValue(
      ok([{ id: 1, externalId: 'b1', provider: 'dbl', hasAudio: false }] as Bible[])
    );
    const client = fakeClient({});
    const result = await syncAudioAvailability(client);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.totalBiblesProcessed).toBe(0);
    }
    expect(client.getBible).not.toHaveBeenCalled();
  });

  it('fetches audio bibles and updates availability for bibles with audio', async () => {
    mockGetAllBibles.mockResolvedValue(
      ok([{ id: 1, externalId: 'b1', provider: 'dbl', hasAudio: true }] as Bible[])
    );
    const client = fakeClient({});
    vi.mocked(client.getBible).mockResolvedValue(
      ok({ audioBibles: [{ id: 'ab1' }, { id: 'ab2' }] } as any)
    );
    vi.mocked(client.getAudioBibleBooks).mockImplementation(async (audioId) => {
      if (audioId === 'ab1') return ok([{ id: 'GEN' }] as any);
      if (audioId === 'ab2') return ok([{ id: 'EXO' }] as any);
      return ok([]);
    });

    const result = await syncAudioAvailability(client);

    expect(result.ok).toBe(true);
    expect(client.getBible).toHaveBeenCalledWith('b1');
    expect(client.getAudioBibleBooks).toHaveBeenCalledWith('ab1');
    expect(client.getAudioBibleBooks).toHaveBeenCalledWith('ab2');

    // Set doesn't guarantee order, so we check the set of elements
    const updateCall = vi.mocked(booksRepo.updateAudioAvailability).mock.calls[0];
    expect(updateCall[0]).toBe(1);
    expect(updateCall[1]).toContain('GEN');
    expect(updateCall[1]).toContain('EXO');
    expect(updateCall[1]).toHaveLength(2);
  });
});
