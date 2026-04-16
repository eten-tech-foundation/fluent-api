import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import { err, ErrorCode, ok } from '@/lib/types';

import * as repo from './projects.repository';
import {
  createProject,
  deleteProject,
  getProjectById,
  getProjectIdByUnitId,
  getProjectsByOrganization,
  updateProject,
} from './projects.service';

const mockTx = { _isMockTx: true };
vi.mock('@/db', () => ({
  db: {
    transaction: vi.fn(),
  },
}));

vi.mock('./projects.repository', () => ({
  getByOrganization: vi.fn(),
  getById: vi.fn(),
  getProjectIdByUnitId: vi.fn(),
  getValidBookIdsForBible: vi.fn(),
  insertProjectRecord: vi.fn(),
  insertProjectUnitRecord: vi.fn(),
  insertBibleBookLinks: vi.fn(),
  updateProjectRecord: vi.fn(),
  updateProjectUnitStatusByProjectId: vi.fn(),
  remove: vi.fn(),
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

describe('projects service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.transaction).mockImplementation(async (cb) => cb(mockTx as any));
  });

  describe('passthrough reads & deletes', () => {
    it('getProjectsByOrganization should call repo', async () => {
      const mockResult = ok([{ id: 1, name: 'Test' }] as any);
      vi.mocked(repo.getByOrganization).mockResolvedValue(mockResult);

      const result = await getProjectsByOrganization(10);

      expect(repo.getByOrganization).toHaveBeenCalledWith(10);
      expect(result).toEqual(mockResult);
    });

    it('getProjectById should call repo', async () => {
      const mockResult = ok({ id: 1, name: 'Test' } as any);
      vi.mocked(repo.getById).mockResolvedValue(mockResult);

      const result = await getProjectById(1);

      expect(repo.getById).toHaveBeenCalledWith(1);
      expect(result).toEqual(mockResult);
    });

    it('deleteProject should call repo', async () => {
      const mockResult = ok(undefined);
      vi.mocked(repo.remove).mockResolvedValue(mockResult);

      const result = await deleteProject(1);

      expect(repo.remove).toHaveBeenCalledWith(1);
      expect(result).toEqual(mockResult);
    });

    it('getProjectIdByUnitId should call repo', async () => {
      const mockResult = ok({ projectId: 99 });
      vi.mocked(repo.getProjectIdByUnitId).mockResolvedValue(mockResult);

      const result = await getProjectIdByUnitId(5);

      expect(repo.getProjectIdByUnitId).toHaveBeenCalledWith(5);
      expect(result).toEqual(mockResult);
    });
  });

  describe('createProject (Orchestration)', () => {
    const mockInput = {
      name: 'New Project',
      sourceLanguage: 1,
      targetLanguage: 2,
      bibleId: 10,
      bookId: [1, 2],
      projectUnitStatus: 'not_started' as const,
      organization: 1,
      createdBy: 99,
    };

    it('should orchestrate project creation successfully', async () => {
      const mockProject = { id: 100, name: 'New Project' } as any;
      const mockUnit = { id: 200, projectId: 100 } as any;

      vi.mocked(repo.getValidBookIdsForBible).mockResolvedValue([1, 2]);
      vi.mocked(repo.insertProjectRecord).mockResolvedValue(mockProject);
      vi.mocked(repo.insertProjectUnitRecord).mockResolvedValue(mockUnit);
      vi.mocked(repo.insertBibleBookLinks).mockResolvedValue(undefined);
      vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue(
        ok([])
      );

      const result = await createProject(mockInput as any);

      expect(repo.getValidBookIdsForBible).toHaveBeenCalledWith(10);
      expect(repo.insertProjectRecord).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New Project', organization: 1, createdBy: 99 }),
        mockTx
      );
      expect(repo.insertProjectUnitRecord).toHaveBeenCalledWith(
        { projectId: 100, status: 'not_started' },
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

      expect(result).toEqual(ok(mockProject));
    });

    it('should return INVALID_BIBLE_BOOKS if any book is invalid', async () => {
      vi.mocked(repo.getValidBookIdsForBible).mockResolvedValue([1]);

      const result = await createProject(mockInput as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.INVALID_BIBLE_BOOKS);
      }

      expect(db.transaction).not.toHaveBeenCalled();
      expect(repo.insertProjectRecord).not.toHaveBeenCalled();
    });

    it('should rollback (return error) if cross-domain assignment fails', async () => {
      const mockProject = { id: 100 } as any;
      const mockUnit = { id: 200 } as any;

      vi.mocked(repo.getValidBookIdsForBible).mockResolvedValue([1, 2]);
      vi.mocked(repo.insertProjectRecord).mockResolvedValue(mockProject);
      vi.mocked(repo.insertProjectUnitRecord).mockResolvedValue(mockUnit);

      vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue(
        err(ErrorCode.INTERNAL_ERROR)
      );

      const result = await createProject(mockInput as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
      }
    });
  });

  describe('updateProject (Orchestration)', () => {
    it('should update project and conditionally update unit status', async () => {
      const mockUpdatedProject = { id: 1, name: 'Updated' } as any;
      vi.mocked(repo.updateProjectRecord).mockResolvedValue(mockUpdatedProject);
      vi.mocked(repo.updateProjectUnitStatusByProjectId).mockResolvedValue(undefined);

      const result = await updateProject(1, {
        name: 'Updated',
        projectUnitStatus: 'in_progress',
      });

      expect(repo.updateProjectRecord).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: 'Updated' }),
        mockTx
      );
      expect(repo.updateProjectUnitStatusByProjectId).toHaveBeenCalledWith(
        1,
        'in_progress',
        mockTx
      );
      expect(result).toEqual(ok(mockUpdatedProject));
    });

    it('should skip updating unit status if it is not provided in input', async () => {
      const mockUpdatedProject = { id: 1, name: 'Updated' } as any;
      vi.mocked(repo.updateProjectRecord).mockResolvedValue(mockUpdatedProject);

      const result = await updateProject(1, { name: 'Updated' });

      expect(repo.updateProjectRecord).toHaveBeenCalled();
      expect(repo.updateProjectUnitStatusByProjectId).not.toHaveBeenCalled();
      expect(result).toEqual(ok(mockUpdatedProject));
    });

    it('should return NOT_FOUND if project record does not exist', async () => {
      vi.mocked(repo.updateProjectRecord).mockResolvedValue(undefined);

      const result = await updateProject(999, { name: 'Updated' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
      }
      expect(repo.updateProjectUnitStatusByProjectId).not.toHaveBeenCalled();
    });
  });
});
