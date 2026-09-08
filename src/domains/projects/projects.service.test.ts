import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { ErrorCode, ok } from '@/lib/types';

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

vi.mock('@/db', () => {
  const createChainableMock = (resolvedValue: any) => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: (resolve: any) => resolve(resolvedValue),
    };
    return vi.fn(() => chainable);
  };

  return {
    db: {
      transaction: vi.fn(),
      selectDistinct: createChainableMock([]),
      select: createChainableMock([]),
      query: {
        books: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    },
  };
});

vi.mock('@/lib/queue', () => ({
  getQueue: vi.fn(),
  QUEUE_NAMES: {
    DBL_INGEST_TEXT: 'dbl-ingest-text',
    DBL_INGEST_TEXT_PRIORITY: 'dbl-ingest-text-priority',
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

    it('deleteProject should call repo if no milestones exist', async () => {
      const mockResult = ok(undefined);
      vi.mocked(repo.remove).mockResolvedValue(mockResult);

      const result = await deleteProject(1);

      expect(repo.remove).toHaveBeenCalledWith(1);
      expect(result).toEqual(mockResult);
    });

    it('deleteProject should return PROJECT_HAS_MILESTONES if milestones exist', async () => {
      vi.mocked(db.select).mockImplementationOnce(() => {
        const chainable = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          then: (resolve: any) => resolve([{ id: 1 }]),
        };
        return chainable as any;
      });

      const result = await deleteProject(1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.PROJECT_HAS_MILESTONES);
      }
      expect(repo.remove).not.toHaveBeenCalled();
    });

    it('getProjectIdByUnitId should call repo', async () => {
      const mockResult = ok({ projectId: 99 });
      vi.mocked(repo.getProjectIdByUnitId).mockResolvedValue(mockResult);

      const result = await getProjectIdByUnitId(5);

      expect(repo.getProjectIdByUnitId).toHaveBeenCalledWith(5);
      expect(result).toEqual(mockResult);
    });
  });

  describe('createProject', () => {
    const mockInput = {
      name: 'New Project',
      sourceLanguage: 1,
      targetLanguage: 2,
      sourceBibleId: 10,
      organization: 1,
      createdBy: 99,
    };

    it('should create project successfully', async () => {
      const mockProject = { id: 100, name: 'New Project' } as any;

      vi.mocked(repo.insertProjectRecord).mockResolvedValue(mockProject);

      const result = await createProject(mockInput as any);

      expect(repo.insertProjectRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Project',
          organization: 1,
          createdBy: 99,
          status: 'not_assigned',
        }),
        mockTx
      );

      expect(result).toEqual(ok(mockProject));
    });
  });

  describe('updateProject', () => {
    it('should update project successfully', async () => {
      const mockUpdatedProject = { id: 1, name: 'Updated' } as any;
      vi.mocked(repo.updateProjectRecord).mockResolvedValue(mockUpdatedProject);

      const result = await updateProject(1, { name: 'Updated' });

      expect(repo.updateProjectRecord).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: 'Updated' }),
        mockTx
      );
      expect(result).toEqual(ok(mockUpdatedProject));
    });

    it('should return NOT_FOUND if project record does not exist', async () => {
      vi.mocked(repo.updateProjectRecord).mockResolvedValue(undefined);

      const result = await updateProject(999, { name: 'Updated' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
      }
    });
  });
});
