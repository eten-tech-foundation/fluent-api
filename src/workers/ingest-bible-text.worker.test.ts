import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '../db';
import { registerDblIngestTextWorker } from './ingest-bible-text.worker';

// Mock dependencies
vi.mock('../db', () => ({
  db: {
    query: {
      bibles: { findFirst: vi.fn() },
      books: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue(true),
        onConflictDoNothing: vi.fn().mockResolvedValue(true),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const queryChain: any = {
          where: vi.fn().mockResolvedValue([]),
          leftJoin: vi.fn(() => queryChain),
          innerJoin: vi.fn(() => queryChain),
          groupBy: vi.fn(() => queryChain),
          as: vi.fn(() => queryChain),
        };
        return queryChain;
      }),
    })),
  },
}));

const mockDblClientInstance = vi.hoisted(() => ({
  getChapters: vi.fn(),
  getVerses: vi.fn(),
  getVerse: vi.fn(),
}));

vi.mock('../lib/services/dbl/dbl.client', () => {
  return {
    dblClient: mockDblClientInstance,
  };
});

describe('dblIngestTextWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers handlers for both priority and background queues', async () => {
    const mockBoss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
    } as any;

    await registerDblIngestTextWorker(mockBoss);

    expect(mockBoss.work).toHaveBeenCalledTimes(2);
    expect(mockBoss.work).toHaveBeenCalledWith('dbl-ingest-text', expect.any(Function));
    expect(mockBoss.work).toHaveBeenCalledWith('dbl-ingest-text-priority', expect.any(Function));
  });

  it('handles partial download error recovery gracefully', async () => {
    const mockBoss = { createQueue: vi.fn(), work: vi.fn() } as any;
    await registerDblIngestTextWorker(mockBoss);

    // Extract the handler
    const handler = mockBoss.work.mock.calls[0][1];

    vi.mocked(db.query.bibles.findFirst).mockResolvedValue({
      id: 1,
      externalId: 'ext-bible-1',
    } as any);
    vi.mocked(db.query.books.findFirst).mockResolvedValue({ id: 1, code: 'GEN' } as any);

    mockDblClientInstance.getChapters.mockResolvedValue({
      ok: true,
      data: [{ id: 'GEN.1', number: '1' } as any, { id: 'GEN.2', number: '2' } as any],
    });

    // Simulate error on chapter 1, but chapter 2 succeeds
    mockDblClientInstance.getVerses
      .mockResolvedValueOnce({ ok: false, error: new Error('Network error on chapter 1') })
      .mockResolvedValueOnce({ ok: true, data: [{ id: 'GEN.2.1', reference: 'Gen 2:1' } as any] });

    mockDblClientInstance.getVerse.mockResolvedValue({
      ok: true,
      data: { content: 'Verse 1' } as any,
    });

    await handler({ data: { bibleId: 1, bookCodes: ['GEN'] }, id: 'job-1' });

    // It should have continued to chapter 2 despite the error in chapter 1
    expect(mockDblClientInstance.getVerses).toHaveBeenCalledTimes(2);
    expect(db.insert).toHaveBeenCalledTimes(1); // Only for chapter 2
  });
});
