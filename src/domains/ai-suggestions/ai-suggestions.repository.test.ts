import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as repo from './ai-suggestions.repository';

// We mock the entire `db` object to return a chainable builder.
const { mockChain } = vi.hoisted(() => {
  return {
    mockChain: {
      select: vi.fn().mockReturnThis(),
      selectDistinct: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((resolve) => resolve([])), // Default safe fallback
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

  describe('getSuggestionContextData', () => {
    it('returns err(PROJECT_UNIT_NOT_FOUND) when project unit does not exist', async () => {
      // Project langs query returns empty
      mockChain.then.mockImplementationOnce((resolve) => resolve([]));

      const result = await repo.getSuggestionContextData(999, 1, 'GEN', 1, 1, 1, 1, 100);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PROJECT_UNIT_NOT_FOUND');
      }
    });
  });

  describe('findProjectUnitAuthContext', () => {
    it('returns null when no records match', async () => {
      mockChain.then.mockImplementationOnce((resolve) => resolve([]));

      const context = await repo.findProjectUnitAuthContext(999);
      expect(context).toBeNull();
    });

    it('returns organization ID and filtered member user IDs', async () => {
      mockChain.then.mockImplementationOnce((resolve) =>
        resolve([
          { organizationId: 10, memberUserId: 101 },
          { organizationId: 10, memberUserId: 102 },
          { organizationId: 10, memberUserId: null },
        ])
      );

      const context = await repo.findProjectUnitAuthContext(1);
      expect(context).toEqual({
        organizationId: 10,
        memberUserIds: [101, 102],
      });
      expect(mockChain.selectDistinct).toHaveBeenCalled();
    });
  });

  describe('upsertAiSuggestions', () => {
    it('returns ok immediately for an empty items array', async () => {
      const result = await repo.upsertAiSuggestions([]);
      expect(result.ok).toBe(true);
      expect(mockChain.select).not.toHaveBeenCalled();
    });
  });
});
