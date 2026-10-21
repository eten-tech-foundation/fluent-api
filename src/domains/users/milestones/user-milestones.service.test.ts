import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MilestoneSummaryRow } from '@/domains/milestones/milestones.types';
import type { UserProjectResponse } from '@/domains/users/projects/user-projects.types';

import * as milestonesService from '@/domains/milestones/milestones.service';
import { getProjectsByUserId } from '@/domains/users/projects/user-projects.service';
import { err, ErrorCode, ok } from '@/lib/types';

import { getMilestonesByUserId, toUserMilestoneResponse } from './user-milestones.service';

vi.mock('@/domains/users/projects/user-projects.service', () => ({
  getProjectsByUserId: vi.fn(),
}));

vi.mock('@/domains/milestones/milestones.service', () => ({
  listMilestonesForProjects: vi.fn(),
}));

const zeroCounts = Object.fromEntries(
  [
    'not_started',
    'draft',
    'peer_check',
    'community_review',
    'linguist_check',
    'theological_check',
    'consultant_check',
    'complete',
  ].map((status) => [status, 0])
) as UserProjectResponse['chapterStatusCounts'];

function project(id: number): UserProjectResponse {
  return {
    id,
    name: 'Baka NT',
    organization: 1,
    isActive: true,
    status: 'not_assigned',
    createdBy: 1,
    createdAt: null,
    updatedAt: null,
    metadata: {},
    sourceBibleId: null,
    pericopeSetId: null,
    lastActivityAt: null,
    sourceLanguageId: 1,
    targetLanguageId: 2,
    sourceLanguageName: 'English',
    targetLanguageName: 'Baka',
    sourceName: null,
    lastChapterActivity: null,
    chapterStatusCounts: zeroCounts,
    milestoneCount: 1,
    workflowConfig: [],
  };
}

const SAMPLE_MILESTONE: MilestoneSummaryRow = {
  id: 12,
  name: 'Mark',
  projectId: 3,
  projectName: 'Baka NT',
};

describe('getMilestonesByUserId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists milestones for the projects the user belongs to', async () => {
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([project(3), project(7)]));
    vi.mocked(milestonesService.listMilestonesForProjects).mockResolvedValue(
      ok([SAMPLE_MILESTONE])
    );

    const result = await getMilestonesByUserId(1, 1);

    expect(result).toEqual(ok([SAMPLE_MILESTONE]));
    expect(getProjectsByUserId).toHaveBeenCalledWith(1, 1);
    expect(milestonesService.listMilestonesForProjects).toHaveBeenCalledWith([3, 7]);
  });

  it('returns an empty list without querying milestones when the user has no projects', async () => {
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([]));

    const result = await getMilestonesByUserId(1, 1);

    expect(result).toEqual(ok([]));
    expect(milestonesService.listMilestonesForProjects).not.toHaveBeenCalled();
  });

  it('returns the project lookup error', async () => {
    vi.mocked(getProjectsByUserId).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    const result = await getMilestonesByUserId(1, 1);

    expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
    expect(milestonesService.listMilestonesForProjects).not.toHaveBeenCalled();
  });

  it('returns the milestone lookup error', async () => {
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([project(3)]));
    vi.mocked(milestonesService.listMilestonesForProjects).mockResolvedValue(
      err(ErrorCode.INTERNAL_ERROR)
    );

    const result = await getMilestonesByUserId(1, 1);

    expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
  });

  it('maps a repository row to the user milestone response', () => {
    expect(toUserMilestoneResponse(SAMPLE_MILESTONE)).toEqual({
      id: 12,
      name: 'Mark',
      projectId: 3,
      projectName: 'Baka NT',
    });
  });
});
