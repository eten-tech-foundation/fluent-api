import { eq, ne } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { chapter_assignments } from '@/db/schema';

import * as repo from './chapter-assignments.repository';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

const { mockDbSelect, mockSelectChain, mockUpdateChain } = vi.hoisted(() => {
  const dbSelect = vi.fn<(selection?: unknown) => unknown>();
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };
  return { mockDbSelect: dbSelect, mockSelectChain: selectChain, mockUpdateChain: updateChain };
});

vi.mock('@/db', () => ({
  db: { select: mockDbSelect },
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((...args) => args),
    ne: vi.fn((...args) => args),
    and: vi.fn((...args) => args),
    or: vi.fn((...args) => args),
    isNull: vi.fn((col) => col),
    isNotNull: vi.fn((col) => ['isNotNull', col]),
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
    vi.mocked(db.select).mockReturnValue(mockSelectChain as any);
    mockSelectChain.from.mockReturnThis();
    mockSelectChain.innerJoin.mockReturnThis();
    mockSelectChain.where.mockReturnThis();
    mockUpdateChain.set.mockReturnThis();
    mockUpdateChain.where.mockReturnThis();
  });

  describe('findForVerse', () => {
    it('requires the assignment Bible to match the verse Bible', async () => {
      const assignment = {
        assignedUserId: 5,
        peerCheckerId: null,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
        organizationId: 2,
        projectId: 3,
      };
      mockSelectChain.limit
        .mockResolvedValueOnce([{ bibleId: 9, bookId: 1, chapterNumber: 4 }])
        .mockResolvedValueOnce([assignment]);

      const result = await repo.findForVerse(12, 3401);

      expect(result).toEqual({ ok: true, data: assignment });
      expect(eq).toHaveBeenCalledWith(chapter_assignments.bibleId, 9);
    });
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

  describe('submitPeerCheckIfEligible', () => {
    it('sets peerCheckerId, status, and submittedTime when the row still matches', async () => {
      const submittedTime = new Date('2026-01-02T00:00:00.000Z');
      const record = {
        id: 1,
        peerCheckerId: 7,
        status: CHAPTER_ASSIGNMENT_STATUS.COMMUNITY_REVIEW,
        submittedTime,
      };
      mockUpdateChain.returning.mockResolvedValueOnce([record]);

      const result = await repo.submitPeerCheckIfEligible(
        1,
        7,
        'community_review',
        submittedTime,
        mockTx()
      );

      expect(result).toEqual(record);
      expect(mockUpdateChain.set).toHaveBeenCalledWith({
        peerCheckerId: 7,
        status: CHAPTER_ASSIGNMENT_STATUS.COMMUNITY_REVIEW,
        submittedTime,
      });
    });

    it('returns null when another submitter already won the race', async () => {
      mockUpdateChain.returning.mockResolvedValueOnce([]);

      const result = await repo.submitPeerCheckIfEligible(
        1,
        7,
        'community_review',
        new Date(),
        mockTx()
      );

      expect(result).toBeNull();
    });

    it('only updates peer_check rows that are open or already assigned to the submitter and whose drafter is not the submitter', async () => {
      mockUpdateChain.returning.mockResolvedValueOnce([
        {
          id: 1,
          peerCheckerId: 7,
          status: CHAPTER_ASSIGNMENT_STATUS.COMMUNITY_REVIEW,
        },
      ]);

      await repo.submitPeerCheckIfEligible(1, 7, 'community_review', new Date(), mockTx());

      expect(ne).toHaveBeenCalledWith(chapter_assignments.assignedUserId, 7);
      expect(mockUpdateChain.where).toHaveBeenCalledWith([
        [chapter_assignments.id, 1],
        [chapter_assignments.status, CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK],
        [chapter_assignments.assignedUserId, 7],
        [chapter_assignments.peerCheckerId, [chapter_assignments.peerCheckerId, 7]],
      ]);
    });
  });

  describe('flagClaimConflict', () => {
    it('sets hasClaimConflict and latches claimConflictUserId under rival non-complete CAS', async () => {
      const record = { id: 1, hasClaimConflict: true, claimConflictUserId: 5 };
      mockUpdateChain.returning.mockResolvedValueOnce([record]);

      const result = await repo.flagClaimConflict(1, 5, mockTx());

      expect(result).toEqual(record);
      expect(mockUpdateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ hasClaimConflict: true })
      );
      expect(mockUpdateChain.where).toHaveBeenCalledWith([
        [chapter_assignments.id, 1],
        ['isNotNull', chapter_assignments.assignedUserId],
        [chapter_assignments.assignedUserId, 5],
        [chapter_assignments.status, CHAPTER_ASSIGNMENT_STATUS.COMPLETE],
      ]);
      expect(ne).toHaveBeenCalledWith(chapter_assignments.assignedUserId, 5);
      expect(ne).toHaveBeenCalledWith(
        chapter_assignments.status,
        CHAPTER_ASSIGNMENT_STATUS.COMPLETE
      );
    });

    it('uses COALESCE so a later claimant does not overwrite claimConflictUserId', async () => {
      mockUpdateChain.returning
        .mockResolvedValueOnce([{ id: 1, hasClaimConflict: true, claimConflictUserId: 5 }])
        .mockResolvedValueOnce([{ id: 1, hasClaimConflict: true, claimConflictUserId: 5 }]);

      await repo.flagClaimConflict(1, 5, mockTx());
      await repo.flagClaimConflict(1, 11, mockTx());

      const firstSet = mockUpdateChain.set.mock.calls[0]?.[0] as {
        hasClaimConflict: boolean;
        claimConflictUserId: unknown;
      };
      const secondSet = mockUpdateChain.set.mock.calls[1]?.[0] as {
        hasClaimConflict: boolean;
        claimConflictUserId: unknown;
      };
      expect(firstSet.hasClaimConflict).toBe(true);
      expect(secondSet.hasClaimConflict).toBe(true);
      // Both writes use SQL COALESCE rather than a bare scalar overwrite.
      expect(firstSet.claimConflictUserId).not.toBe(5);
      expect(secondSet.claimConflictUserId).not.toBe(11);
      expect(mockUpdateChain.where).toHaveBeenNthCalledWith(1, [
        [chapter_assignments.id, 1],
        ['isNotNull', chapter_assignments.assignedUserId],
        [chapter_assignments.assignedUserId, 5],
        [chapter_assignments.status, CHAPTER_ASSIGNMENT_STATUS.COMPLETE],
      ]);
      expect(mockUpdateChain.where).toHaveBeenNthCalledWith(2, [
        [chapter_assignments.id, 1],
        ['isNotNull', chapter_assignments.assignedUserId],
        [chapter_assignments.assignedUserId, 11],
        [chapter_assignments.status, CHAPTER_ASSIGNMENT_STATUS.COMPLETE],
      ]);
    });

    it('returns null when the rival-assignee CAS misses', async () => {
      mockUpdateChain.returning.mockResolvedValueOnce([]);

      const result = await repo.flagClaimConflict(1, 5, mockTx());

      expect(result).toBeNull();
    });
  });
});
