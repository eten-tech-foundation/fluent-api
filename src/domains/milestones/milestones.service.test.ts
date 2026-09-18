import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import * as projectsRepo from '@/domains/projects/projects.repository';
import { ErrorCode, ok } from '@/lib/types';

import * as repo from './milestones.repository';
import {
  createMilestone,
  deleteMilestone,
  getMilestone,
  listMilestonesForProject,
  listMilestonesForProjects,
} from './milestones.service';

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

vi.mock('./milestones.repository', () => ({
  listByProjectId: vi.fn(),
  listByProjectIds: vi.fn(),
  getByIdForProject: vi.fn(),
  insertMilestone: vi.fn(),
  updateMilestone: vi.fn(),
  deleteMilestone: vi.fn(),
}));

vi.mock('@/domains/projects/projects.repository', () => ({
  getValidBookIdsForBible: vi.fn(),
  insertBibleBookLinks: vi.fn(),
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

const sampleMilestone = {
  id: 12,
  name: 'Mark',
  status: 'not_started' as const,
  type: 'text' as const,
  connectivityProfile: null,
  projectId: 3,
  projectName: 'Baka NT',
  milestoneCount: 1,
  bookCount: 1,
  bookIds: [41],
  chapterStatusCounts: {
    not_started: 16,
    draft: 0,
    peer_check: 0,
    community_review: 0,
    linguist_check: 0,
    theological_check: 0,
    consultant_check: 0,
    complete: 0,
  },
};

describe('milestones service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.transaction).mockImplementation(async (cb) => cb(mockTx as any));
  });

  it('lists milestones for a project', async () => {
    vi.mocked(repo.listByProjectId).mockResolvedValue(ok([sampleMilestone]));

    const result = await listMilestonesForProject(3);

    expect(repo.listByProjectId).toHaveBeenCalledWith(3);
    expect(result).toEqual(ok([sampleMilestone]));
  });

  it('lists milestones across projects', async () => {
    vi.mocked(repo.listByProjectIds).mockResolvedValue(ok([sampleMilestone]));

    const result = await listMilestonesForProjects([3, 7]);

    expect(repo.listByProjectIds).toHaveBeenCalledWith([3, 7]);
    expect(result).toEqual(ok([sampleMilestone]));
  });

  it('gets a milestone that belongs to the project', async () => {
    vi.mocked(repo.getByIdForProject).mockResolvedValue(ok(sampleMilestone));

    const result = await getMilestone(3, 12);

    expect(repo.getByIdForProject).toHaveBeenCalledWith(3, 12);
    expect(result).toEqual(ok(sampleMilestone));
  });

  it('creates a milestone inheriting the project bible', async () => {
    const createdUnit = { id: 12, projectId: 3, name: 'Mark' };
    vi.mocked(projectsRepo.getValidBookIdsForBible).mockResolvedValue([41]);
    vi.mocked(repo.insertMilestone).mockResolvedValue(createdUnit as any);
    vi.mocked(projectsRepo.insertBibleBookLinks).mockResolvedValue(undefined);
    vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue(
      ok([])
    );
    vi.mocked(repo.getByIdForProject).mockResolvedValue(ok(sampleMilestone));

    const result = await createMilestone(3, 9, {
      name: 'Mark',
      bookId: [41],
      type: 'text',
      status: 'not_started',
    });

    expect(projectsRepo.getValidBookIdsForBible).toHaveBeenCalledWith(9);
    expect(repo.insertMilestone).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 3, name: 'Mark', type: 'text' }),
      mockTx
    );
    expect(projectsRepo.insertBibleBookLinks).toHaveBeenCalledWith(
      [{ projectUnitId: 12, bibleId: 9, bookId: 41 }],
      mockTx
    );
    expect(chapterAssignmentsService.createChapterAssignmentForProjectUnit).toHaveBeenCalledWith(
      12,
      9,
      [41],
      mockTx
    );
    expect(result).toEqual(ok(sampleMilestone));
  });

  it('rejects books that do not belong to the project bible', async () => {
    vi.mocked(projectsRepo.getValidBookIdsForBible).mockResolvedValue([1]);

    const result = await createMilestone(3, 9, {
      name: 'Mark',
      bookId: [41],
      type: 'text',
      status: 'not_started',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INVALID_BIBLE_BOOKS);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('deletes one milestone', async () => {
    vi.mocked(repo.deleteMilestone).mockResolvedValue(ok(undefined));

    const result = await deleteMilestone(3, 12);

    expect(repo.deleteMilestone).toHaveBeenCalledWith(3, 12);
    expect(result).toEqual(ok(undefined));
  });
});
