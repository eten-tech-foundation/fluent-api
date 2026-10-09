import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MilestoneSummaryRow } from '@/domains/milestones/milestones.types';
import type { UserProjectResponse } from '@/domains/users/projects/user-projects.types';
import type { UserResponse } from '@/domains/users/users.types';
import type { Permission } from '@/lib/permissions';

import { chapterStatusEnum } from '@/db/schema';
import * as milestonesService from '@/domains/milestones/milestones.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getProjectsByUserId } from '@/domains/users/projects/user-projects.service';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import './user-milestones.route';

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => {
  const mockQueryBuilder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ activeOrgId: 1 }]),
  };
  return {
    db: { select: vi.fn(() => mockQueryBuilder), insert: vi.fn(), update: vi.fn() },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/domains/user-roles/user-roles.repository', () => ({
  findGrantsByUserId: vi.fn(),
}));

vi.mock('@/domains/users/projects/user-projects.service', () => ({
  getProjectsByUserId: vi.fn(),
}));

vi.mock('@/domains/milestones/milestones.service', () => ({
  listMilestonesForProjects: vi.fn(),
}));

const APP_USER: UserResponse = {
  id: 1,
  email: 'pm@example.com',
  username: 'pm',
  firstName: null,
  lastName: null,
  createdBy: null,
  status: 'verified',
  createdAt: null,
  updatedAt: null,
  lastActiveOrgId: null,
};

const zeroCounts = Object.fromEntries(
  chapterStatusEnum.enumValues.map((status) => [status, 0])
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

function asAuthenticatedUser(permissions: Permission[] = [PERMISSIONS.PROJECT_VIEW]) {
  const now = new Date();
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {
      id: 's1',
      userId: 'auth-user-1',
      token: 'test-session-token',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 1e9),
    },
    user: {
      id: 'auth-user-1',
      name: APP_USER.username,
      email: APP_USER.email,
      emailVerified: true,
      banned: false,
      twoFactorEnabled: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  vi.mocked(getUserByEmail).mockResolvedValue(ok(APP_USER));
  vi.mocked(findGrantsByUserId).mockResolvedValue(
    ok([{ orgId: 1, projectId: 3, permissions: new Set(permissions) }])
  );
}

describe('get /users/{userId}/milestones', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    const res = await server.request('/users/1/milestones', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller lacks project:view', async () => {
    asAuthenticatedUser([]);

    const res = await server.request('/users/1/milestones', { method: 'GET' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'Insufficient permissions' });
    expect(getProjectsByUserId).not.toHaveBeenCalled();
  });

  it('returns 403 when the path userId is not the authenticated user', async () => {
    asAuthenticatedUser();

    const res = await server.request('/users/99/milestones', { method: 'GET' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'You can only access your own resources' });
    expect(getProjectsByUserId).not.toHaveBeenCalled();
  });

  it('returns a flat list of milestones for projects the caller can access', async () => {
    asAuthenticatedUser();
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([project(3), project(7)]));
    vi.mocked(milestonesService.listMilestonesForProjects).mockResolvedValue(
      ok([SAMPLE_MILESTONE])
    );

    const res = await server.request('/users/1/milestones', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([SAMPLE_MILESTONE]);
    expect(getProjectsByUserId).toHaveBeenCalledWith(1, 1);
    expect(milestonesService.listMilestonesForProjects).toHaveBeenCalledWith([3, 7]);
  });

  it('returns an empty list when the caller has no projects', async () => {
    asAuthenticatedUser();
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([]));

    const res = await server.request('/users/1/milestones', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(milestonesService.listMilestonesForProjects).not.toHaveBeenCalled();
  });

  it('returns the service error status when project lookup fails', async () => {
    asAuthenticatedUser();
    vi.mocked(getProjectsByUserId).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    const res = await server.request('/users/1/milestones', { method: 'GET' });

    expect(res.status).toBe(500);
    expect(milestonesService.listMilestonesForProjects).not.toHaveBeenCalled();
  });
});
