import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ok } from '@/lib/types';

import * as repo from './project-chapter-assignments.repository';
import { getProjectChapterAssignments } from './project-chapter-assignments.service';

vi.mock('@/db', () => {
  const chainable = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    as: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve: any) => resolve([]),
  };
  return {
    db: {
      select: vi.fn(() => chainable),
      selectDistinct: vi.fn(() => chainable),
      transaction: vi.fn(),
    },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/chapter-assignments/chapter-assignments.service', () => ({
  toChapterAssignmentResponse: vi.fn((record) => record),
}));

vi.mock('./project-chapter-assignments.repository', () => ({
  getByProject: vi.fn(),
}));

const SAMPLE_ASSIGNMENT = {
  id: 81,
  projectUnitId: 12,
  bibleId: 1,
  bookId: 2,
  chapterNumber: 1,
  assignedUserId: null,
  peerCheckerId: null,
  status: 'not_started',
  submittedTime: null,
  isAiEnabled: false,
  hasClaimConflict: false,
  claimConflictUserId: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

describe('getProjectChapterAssignments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards an optional milestoneId filter to the repository', async () => {
    vi.mocked(repo.getByProject).mockResolvedValue(ok([SAMPLE_ASSIGNMENT as any]));

    const result = await getProjectChapterAssignments(3, 12);

    expect(repo.getByProject).toHaveBeenCalledWith(3, 12);
    expect(result).toEqual(ok([SAMPLE_ASSIGNMENT]));
  });

  it('omits the filter when listing every unit on the project', async () => {
    vi.mocked(repo.getByProject).mockResolvedValue(ok([]));

    await getProjectChapterAssignments(3);

    expect(repo.getByProject).toHaveBeenCalledWith(3, undefined);
  });
});
