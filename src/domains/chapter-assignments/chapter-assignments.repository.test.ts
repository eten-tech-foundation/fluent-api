import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as repo from './chapter-assignments.repository';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

const { mockUpdateChain } = vi.hoisted(() => {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  return { mockUpdateChain: chain };
});

vi.mock('@/db', () => ({
  db: {},
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((...args) => args),
    and: vi.fn((...args) => args),
    isNull: vi.fn((col) => col),
  };
});

vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

function mockTx() {
  return {
    update: vi.fn(() => mockUpdateChain),
  } as any;
}

describe('chapter-assignments.repository claim helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateChain.set.mockReturnThis();
    mockUpdateChain.where.mockReturnThis();
  });

  describe('claimIfUnassigned', () => {
    it('returns claimed=true when the conditional update affects a row', async () => {
      const record = {
        id: 1,
        assignedUserId: 5,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
        hasClaimConflict: false,
      };
      mockUpdateChain.returning.mockResolvedValueOnce([record]);

      const tx = mockTx();
      const result = await repo.claimIfUnassigned(1, 5, tx);

      expect(result.claimed).toBe(true);
      expect(result.record).toEqual(record);
      expect(tx.update).toHaveBeenCalled();
      expect(mockUpdateChain.set).toHaveBeenCalledWith({
        assignedUserId: 5,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
      });
    });

    it('returns claimed=false when no row matches the conditional update', async () => {
      mockUpdateChain.returning.mockResolvedValueOnce([]);

      const result = await repo.claimIfUnassigned(1, 5, mockTx());

      expect(result.claimed).toBe(false);
      expect(result.record).toBeNull();
    });
  });

  describe('flagClaimConflict', () => {
    it('sets hasClaimConflict and claimConflictUserId', async () => {
      const record = { id: 1, hasClaimConflict: true, claimConflictUserId: 5 };
      mockUpdateChain.returning.mockResolvedValueOnce([record]);

      const result = await repo.flagClaimConflict(1, 5, mockTx());

      expect(result).toEqual(record);
      expect(mockUpdateChain.set).toHaveBeenCalledWith({
        hasClaimConflict: true,
        claimConflictUserId: 5,
      });
    });
  });
});
