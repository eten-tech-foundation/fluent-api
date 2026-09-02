import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { chapter_assignments } from '@/db/schema';
import { VERSE_AUDIO_CONFLICT_STATUS } from '@/domains/verse-audio/verse-audio.types';

import * as repo from './chapter-assignments.repository';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

const { mockSelectChain, mockUpdateChain } = vi.hoisted(() => {
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
  return { mockSelectChain: selectChain, mockUpdateChain: updateChain };
});

vi.mock('@/db', () => ({
  db: { select: vi.fn() },
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

  describe('findAssignmentsProgress hasConflict rollup', () => {
    it('wires the verse-audio conflict-status constant into the rollup', async () => {
      // Guards against renaming VERSE_AUDIO_CONFLICT_STATUS.CONFLICT without
      // updating the raw SQL rollup in findAssignmentsProgress.
      expect(VERSE_AUDIO_CONFLICT_STATUS.CONFLICT).toBe('conflict');

      const orderBy = vi.fn().mockResolvedValue([
        {
          assignmentId: 1,
          projectId: 3,
          projectName: 'P',
          projectUnitId: 12,
          bibleId: 9,
          bibleName: 'B',
          bookId: 1,
          bookCode: 'JHN',
          bookNameEng: 'John',
          chapterNumber: 3,
          status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
          targetLanguage: 'en',
          targetLangCode: 'eng',
          sourceLangCode: 'grc',
          totalVerses: 1,
          completedVerses: 0,
          assignedUserId: 5,
          assignedUserDisplayName: 'u',
          peerCheckerId: null,
          peerCheckerDisplayName: null,
          submittedTime: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          isAiEnabled: false,
          hasClaimConflict: false,
          claimConflictUserId: null,
          hasConflict: true,
        },
      ]);
      const groupBy = vi.fn().mockReturnValue({ orderBy });
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        groupBy,
      };
      vi.mocked(db.select).mockReturnValue(selectChain as any);

      const result = await repo.findAssignmentsProgress({ projectId: 3 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data[0]?.hasConflict).toBe(true);
      }
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
