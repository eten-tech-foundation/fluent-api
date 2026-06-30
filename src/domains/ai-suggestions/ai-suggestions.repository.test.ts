import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as repo from './ai-suggestions.repository';

// We mock the entire `db` object to return a chainable builder.
const { mockChain } = vi.hoisted(() => {
  return {
    mockChain: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
      then: vi.fn(), // We mock `then` dynamically to resolve queries
    },
  };
});

vi.mock('@/db', () => ({
  db: mockChain,
}));

// Mock drizzle-orm operators so they don't crash
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn(),
    and: vi.fn(),
    gt: vi.fn(),
    inArray: vi.fn(),
    isNull: vi.fn(),
    asc: vi.fn(),
    sql: vi.fn(),
  };
});

describe('ai-suggestions.repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findNextUntranslatedVerses', () => {
    it('returns array of verse numbers up to the lookahead limit', async () => {
      // Mock the final resolution of the query
      mockChain.then.mockImplementationOnce((resolve) =>
        resolve([{ verseNumber: 10 }, { verseNumber: 11 }])
      );

      const verses = await repo.findNextUntranslatedVerses(1, 1, 'GEN', 1, 9, 3);

      expect(verses).toEqual([10, 11]);
      expect(mockChain.select).toHaveBeenCalled();
      expect(mockChain.from).toHaveBeenCalled();
      expect(mockChain.limit).toHaveBeenCalledWith(3);
    });
  });

  describe('hasReachedAiActivationThreshold', () => {
    it('returns false if project info cannot be found', async () => {
      // First query: project info returns empty
      mockChain.then.mockImplementationOnce((resolve) => resolve([]));

      const reached = await repo.hasReachedAiActivationThreshold(1, 5);
      expect(reached).toBe(false);
    });

    it('returns true if threshold is met', async () => {
      // First query: project info
      mockChain.then.mockImplementationOnce((resolve) =>
        resolve([{ sourceLanguage: 1, targetLanguage: 2, organization: 1 }])
      );
      // Second query: translated verses
      mockChain.then.mockImplementationOnce((resolve) => resolve([{ id: 10 }]));

      const reached = await repo.hasReachedAiActivationThreshold(1, 5);
      expect(reached).toBe(true);
      expect(mockChain.offset).toHaveBeenCalledWith(4); // 5 - 1
    });

    it('returns false if threshold is not met', async () => {
      // First query: project info
      mockChain.then.mockImplementationOnce((resolve) =>
        resolve([{ sourceLanguage: 1, targetLanguage: 2, organization: 1 }])
      );
      // Second query: translated verses (empty)
      mockChain.then.mockImplementationOnce((resolve) => resolve([]));

      const reached = await repo.hasReachedAiActivationThreshold(1, 5);
      expect(reached).toBe(false);
    });
  });
});
