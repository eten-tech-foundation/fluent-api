import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import { err, ErrorCode, ok } from '@/lib/types';

import * as repo from './milestones.repository';
import {
  createMilestone,
  deleteMilestone,
  getMilestone,
  getMilestones,
  updateMilestone,
} from './milestones.service';

const mockTx = { _isMockTx: true };

vi.mock('@/db', () => ({
  db: {
    transaction: vi.fn(),
    query: {
      books: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  },
}));

vi.mock('@/lib/queue', () => ({
  getQueue: vi.fn(),
  QUEUE_NAMES: {
    DBL_INGEST_TEXT: 'dbl-ingest-text',
  },
}));

vi.mock('./milestones.repository', () => ({
  getValidBookIdsForBible: vi.fn(),
  insertMilestoneRecord: vi.fn(),
  insertBibleBookLinks: vi.fn(),
  getMilestonesByProjectId: vi.fn(),
  getMilestoneById: vi.fn(),
  updateMilestoneRecord: vi.fn(),
  moveBookToMilestone: vi.fn(),
  deleteMilestoneRecord: vi.fn(),
}));

vi.mock('@/domains/chapter-assignments/chapter-assignments.service', () => ({
  createChapterAssignmentForProjectUnit: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('milestones service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.transaction).mockImplementation(async (cb) => cb(mockTx as any));
  });

  describe('createMilestone', () => {
    const mockInput = {
      name: 'New Milestone',
      type: 'translation',
      status: 'not_started' as const,
      bibleId: 10,
      bookIds: [1, 2],
    };

    it('should create milestone successfully', async () => {
      const mockMilestone = { id: 200, projectId: 100 } as any;

      vi.mocked(repo.getValidBookIdsForBible).mockResolvedValue([1, 2]);
      vi.mocked(repo.insertMilestoneRecord).mockResolvedValue(mockMilestone);
      vi.mocked(repo.insertBibleBookLinks).mockResolvedValue(undefined);
      vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue(
        ok([])
      );

      const result = await createMilestone(100, mockInput as any);

      expect(repo.getValidBookIdsForBible).toHaveBeenCalledWith(10, [1, 2]);
      expect(repo.insertMilestoneRecord).toHaveBeenCalledWith(
        100,
        { name: 'New Milestone', type: 'translation', status: 'not_started' },
        mockTx
      );
      expect(repo.insertBibleBookLinks).toHaveBeenCalledWith(
        [
          { projectUnitId: 200, bibleId: 10, bookId: 1 },
          { projectUnitId: 200, bibleId: 10, bookId: 2 },
        ],
        mockTx
      );
      expect(chapterAssignmentsService.createChapterAssignmentForProjectUnit).toHaveBeenCalledWith(
        200,
        10,
        [1, 2],
        mockTx
      );

      expect(result).toEqual(ok(mockMilestone));
    });

    it('should return INVALID_BIBLE_BOOKS if any book is invalid', async () => {
      vi.mocked(repo.getValidBookIdsForBible).mockResolvedValue([1]);

      const result = await createMilestone(100, mockInput as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.INVALID_BIBLE_BOOKS);
      }

      expect(db.transaction).not.toHaveBeenCalled();
      expect(repo.insertMilestoneRecord).not.toHaveBeenCalled();
    });

    it('should rollback (return error) if cross-domain assignment fails', async () => {
      const mockMilestone = { id: 200 } as any;

      vi.mocked(repo.getValidBookIdsForBible).mockResolvedValue([1, 2]);
      vi.mocked(repo.insertMilestoneRecord).mockResolvedValue(mockMilestone);

      vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue(
        err(ErrorCode.INTERNAL_ERROR)
      );

      const result = await createMilestone(100, mockInput as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
      }
    });
  });

  describe('updateMilestone', () => {
    it('should update milestone successfully', async () => {
      const mockUpdatedMilestone = { id: 1, name: 'Updated' } as any;
      vi.mocked(repo.updateMilestoneRecord).mockResolvedValue(mockUpdatedMilestone);

      const result = await updateMilestone(1, { name: 'Updated' });

      expect(repo.updateMilestoneRecord).toHaveBeenCalledWith(1, { name: 'Updated' }, mockTx);
      expect(result).toEqual(ok(mockUpdatedMilestone));
    });

    it('should return NOT_FOUND if milestone record does not exist', async () => {
      vi.mocked(repo.updateMilestoneRecord).mockResolvedValue(undefined as any);

      const result = await updateMilestone(999, { name: 'Updated' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
      }
    });

    it('should move books if requested', async () => {
      const mockUpdatedMilestone = { id: 1, name: 'Updated' } as any;
      vi.mocked(repo.updateMilestoneRecord).mockResolvedValue(mockUpdatedMilestone);
      vi.mocked(repo.moveBookToMilestone).mockResolvedValue(undefined);

      const result = await updateMilestone(1, {
        moveBooks: [{ bookId: 2, targetMilestoneId: 3 }],
      });

      expect(repo.moveBookToMilestone).toHaveBeenCalledWith(2, 1, 3, mockTx);
      expect(result).toEqual(ok(mockUpdatedMilestone));
    });
  });

  describe('passthrough reads and deletes', () => {
    it('getMilestones should call repo', async () => {
      const mockResult = [{ id: 1 }] as any;
      vi.mocked(repo.getMilestonesByProjectId).mockResolvedValue(mockResult);

      const result = await getMilestones(100);
      expect(repo.getMilestonesByProjectId).toHaveBeenCalledWith(100);
      expect(result).toEqual(ok(mockResult));
    });

    it('getMilestone should call repo', async () => {
      const mockResult = { id: 1 } as any;
      vi.mocked(repo.getMilestoneById).mockResolvedValue(mockResult);

      const result = await getMilestone(1);
      expect(repo.getMilestoneById).toHaveBeenCalledWith(1);
      expect(result).toEqual(ok(mockResult));
    });

    it('getMilestone should return NOT_FOUND if missing', async () => {
      vi.mocked(repo.getMilestoneById).mockResolvedValue(undefined as any);

      const result = await getMilestone(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
      }
    });

    it('deleteMilestone should call repo', async () => {
      vi.mocked(repo.deleteMilestoneRecord).mockResolvedValue(undefined);

      const result = await deleteMilestone(1);
      expect(repo.deleteMilestoneRecord).toHaveBeenCalledWith(1);
      expect(result).toEqual(ok(undefined));
    });
  });
});
