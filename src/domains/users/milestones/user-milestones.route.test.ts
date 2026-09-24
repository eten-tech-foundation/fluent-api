import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as milestonesService from '@/domains/milestones/milestones.service';
import { getProjectsByUserId } from '@/domains/projects/projects.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
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

vi.mock('@/domains/projects/projects.service', () => ({
  getProjectsByUserId: vi.fn(),
}));

vi.mock('@/domains/milestones/milestones.service', () => ({
  listMilestonesForProjects: vi.fn(),
}));

const APP_USER = {
  id: 1,
  email: 'pm@example.com',
  role: 2,
  roleName: 'Project Manager',
  organization: 1,
  status: 'verified' as const,
};

const SAMPLE_MILESTONE = {
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

function asAuthenticatedUser(permissions: string[] = [PERMISSIONS.PROJECT_VIEW]) {
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: APP_USER.email },
  });
  (getUserByEmail as any).mockResolvedValue(ok(APP_USER));
  (findGrantsByUserId as any).mockResolvedValue(
    ok([{ orgId: 1, projectId: 3, permissions: new Set(permissions) }])
  );
}

describe('get /users/{userId}/milestones', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);
    const res = await server.request('/users/1/milestones', { method: 'GET' });
    expect(res.status).toBe(401);
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
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([{ id: 3 }, { id: 7 }] as any));
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
    vi.mocked(milestonesService.listMilestonesForProjects).mockResolvedValue(ok([]));

    const res = await server.request('/users/1/milestones', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(milestonesService.listMilestonesForProjects).toHaveBeenCalledWith([]);
  });

  it('returns the service error status when project lookup fails', async () => {
    asAuthenticatedUser();
    vi.mocked(getProjectsByUserId).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    const res = await server.request('/users/1/milestones', { method: 'GET' });

    expect(res.status).toBe(500);
    expect(milestonesService.listMilestonesForProjects).not.toHaveBeenCalled();
  });
});
