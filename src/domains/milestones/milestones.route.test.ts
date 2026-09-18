import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import * as milestonesService from './milestones.service';
import './milestones.route';

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
  getProjectById: vi.fn(),
}));

vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

vi.mock('./milestones.service', () => ({
  listMilestonesForProject: vi.fn(),
  createMilestone: vi.fn(),
  getMilestone: vi.fn(),
  updateMilestone: vi.fn(),
  deleteMilestone: vi.fn(),
}));

const APP_USER = {
  id: 1,
  email: 'pm@example.com',
  role: 2,
  roleName: 'Project Manager',
  organization: 1,
  status: 'verified' as const,
};

const MOCK_PROJECT = {
  id: 3,
  name: 'Baka NT',
  organization: 1,
  sourceBibleId: 9,
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

function asProjectMember() {
  vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
  vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
}

describe('milestones routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);
    const res = await server.request('/projects/3/milestones', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('returns named units for a project', async () => {
    asAuthenticatedUser();
    asProjectMember();
    vi.mocked(milestonesService.listMilestonesForProject).mockResolvedValue(ok([SAMPLE_MILESTONE]));

    const res = await server.request('/projects/3/milestones', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].name).toBe('Mark');
    expect(body[0].projectName).toBe('Baka NT');
    expect(body[0].milestoneCount).toBe(1);
  });

  it('returns 404 when the unit is not on the project', async () => {
    asAuthenticatedUser();
    asProjectMember();
    vi.mocked(milestonesService.getMilestone).mockResolvedValue(
      err(ErrorCode.PROJECT_UNIT_NOT_FOUND)
    );

    const res = await server.request('/projects/3/milestones/999', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('creates a milestone', async () => {
    asAuthenticatedUser([PERMISSIONS.PROJECT_UPDATE]);
    asProjectMember();
    vi.mocked(milestonesService.createMilestone).mockResolvedValue(ok(SAMPLE_MILESTONE));

    const res = await server.request('/projects/3/milestones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Exodus', bookId: [2] }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(SAMPLE_MILESTONE);
    expect(milestonesService.createMilestone).toHaveBeenCalledWith(
      3,
      9,
      expect.objectContaining({ name: 'Exodus', bookId: [2] })
    );
  });

  it('returns 400 when create payload has duplicate book IDs', async () => {
    asAuthenticatedUser([PERMISSIONS.PROJECT_UPDATE]);
    asProjectMember();

    const res = await server.request('/projects/3/milestones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mark', bookId: [41, 41] }),
    });

    expect(res.status).toBe(400);
    expect(milestonesService.createMilestone).not.toHaveBeenCalled();
  });

  it('returns 400 when create rejects books that are not on the project Bible', async () => {
    asAuthenticatedUser([PERMISSIONS.PROJECT_UPDATE]);
    asProjectMember();
    vi.mocked(milestonesService.createMilestone).mockResolvedValue(
      err(ErrorCode.INVALID_BIBLE_BOOKS)
    );

    const res = await server.request('/projects/3/milestones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mark', bookId: [41] }),
    });

    expect(res.status).toBe(400);
  });

  it('updates a milestone', async () => {
    asAuthenticatedUser([PERMISSIONS.PROJECT_UPDATE]);
    asProjectMember();
    const updated = { ...SAMPLE_MILESTONE, name: 'Luke' };
    vi.mocked(milestonesService.updateMilestone).mockResolvedValue(ok(updated));

    const res = await server.request('/projects/3/milestones/12', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Luke' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(updated);
    expect(milestonesService.updateMilestone).toHaveBeenCalledWith(3, 12, { name: 'Luke' });
  });

  it('returns 422 when PATCH has no updatable fields', async () => {
    asAuthenticatedUser([PERMISSIONS.PROJECT_UPDATE]);
    asProjectMember();

    const res = await server.request('/projects/3/milestones/12', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ message: 'No updates provided' });
    expect(milestonesService.updateMilestone).not.toHaveBeenCalled();
  });

  it('deletes a milestone', async () => {
    asAuthenticatedUser([PERMISSIONS.PROJECT_DELETE]);
    asProjectMember();
    vi.mocked(milestonesService.deleteMilestone).mockResolvedValue(ok(undefined));

    const res = await server.request('/projects/3/milestones/12', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(milestonesService.deleteMilestone).toHaveBeenCalledWith(3, 12);
  });
});
