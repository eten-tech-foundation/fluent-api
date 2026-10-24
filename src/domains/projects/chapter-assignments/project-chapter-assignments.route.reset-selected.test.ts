import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Permission } from '@/lib/permissions';

import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import * as service from './project-chapter-assignments.service';
import './project-chapter-assignments.route';

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

// FA-L7 exception: authenticateUser / project access middleware still touch `@/db`
// at import time. The route under test mocks the service leaf.
vi.mock('@/db', () => {
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ activeOrgId: 1 }]),
  };
  return {
    db: {
      select: vi.fn(() => query),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    },
  };
});

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

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./project-chapter-assignments.service', () => ({
  getProjectChapterAssignments: vi.fn(),
  deleteChapterAssignmentsByProject: vi.fn(),
  getChapterAssignmentProgressByProject: vi.fn(),
  assignAllProjectChapterAssignmentsToUser: vi.fn(),
  assignSelectedChapters: vi.fn(),
  resetSelectedChapters: vi.fn(),
  getChapterAssignmentsByUserId: vi.fn(),
}));

const project = { id: 1, organization: 1 };

function asAuthenticatedUser(permissions: Permission[]) {
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {
      id: 'session-1',
      userId: 'auth-user-1',
      token: 'test-session-token',
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 1e9),
    },
    user: {
      id: 'auth-user-1',
      name: 'user',
      email: 'user@example.com',
      emailVerified: true,
      banned: false,
      twoFactorEnabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  vi.mocked(getUserByEmail).mockResolvedValue(
    ok({
      id: 1,
      email: 'user@example.com',
      username: 'user',
      firstName: null,
      lastName: null,
      createdBy: null,
      status: 'verified',
      createdAt: null,
      updatedAt: null,
      lastActiveOrgId: null,
    })
  );
  vi.mocked(findGrantsByUserId).mockResolvedValue(
    ok([
      {
        orgId: 1,
        projectId: 1,
        permissions: new Set(permissions),
      },
    ])
  );
  vi.mocked(getProjectById).mockResolvedValue(ok(project as never));
  vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
}

function resetSelected(body: unknown) {
  return server.request('/projects/1/chapter-assignments/reset-selected', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /projects/:projectId/chapter-assignments/reset-selected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller lacks content:assign', async () => {
    asAuthenticatedUser([PERMISSIONS.PROJECT_VIEW, PERMISSIONS.PROJECT_UPDATE]);

    const response = await resetSelected({ chapterAssignmentIds: [11] });

    expect(response.status).toBe(403);
    expect(service.resetSelectedChapters).not.toHaveBeenCalled();
  });

  it('returns 200 for a manager and forwards the ids', async () => {
    asAuthenticatedUser([
      PERMISSIONS.CONTENT_ASSIGN,
      PERMISSIONS.PROJECT_VIEW,
      PERMISSIONS.PROJECT_UPDATE,
    ]);
    vi.mocked(service.resetSelectedChapters).mockResolvedValue(ok([]));

    const response = await resetSelected({ chapterAssignmentIds: [11, 12] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(service.resetSelectedChapters).toHaveBeenCalledWith(1, [11, 12]);
  });

  it('maps CHAPTER_ASSIGNMENT_NOT_RESETTABLE to 409', async () => {
    asAuthenticatedUser([
      PERMISSIONS.CONTENT_ASSIGN,
      PERMISSIONS.PROJECT_VIEW,
      PERMISSIONS.PROJECT_UPDATE,
    ]);
    vi.mocked(service.resetSelectedChapters).mockResolvedValue(
      err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_RESETTABLE)
    );

    const response = await resetSelected({ chapterAssignmentIds: [11] });

    expect(response.status).toBe(409);
  });
});
