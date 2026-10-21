import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserResponse } from '@/domains/users/users.types';
import type { Permission } from '@/lib/permissions';

import { getChapterAssignmentsByUserId } from '@/domains/projects/chapter-assignments/project-chapter-assignments.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { ok } from '@/lib/types';
import { server } from '@/server/server';

import './users-chapter-assignments.route';

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

vi.mock('@/domains/projects/chapter-assignments/project-chapter-assignments.service', () => ({
  getChapterAssignmentsByUserId: vi.fn(),
}));

vi.mock('@/domains/users/chapter-assignments/users-chapter-assignments.service', () => ({
  getAllChapterAssignmentsByUserId: vi.fn(),
}));

const APP_USER: UserResponse = {
  id: 1,
  email: 'member@example.com',
  username: 'member',
  firstName: null,
  lastName: null,
  createdBy: null,
  status: 'verified',
  createdAt: null,
  updatedAt: null,
  lastActiveOrgId: null,
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
    ok([{ orgId: 1, projectId: null, permissions: new Set(permissions) }])
  );
}

describe('get /users/{userId}/chapter-assignments/all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards excludeProjectIds and updatedAfter', async () => {
    asAuthenticatedUser();
    vi.mocked(getChapterAssignmentsByUserId).mockResolvedValue(ok([]));

    const res = await server.request(
      '/users/1/chapter-assignments/all?excludeProjectIds=97,98&updatedAfter=2025-01-01T00:00:00.000Z',
      { method: 'GET' }
    );

    expect(res.status).toBe(200);
    expect(getChapterAssignmentsByUserId).toHaveBeenCalledWith(
      1,
      [97, 98],
      new Date('2025-01-01T00:00:00.000Z'),
      1
    );
  });

  it.each(['abc', '1,abc,2', '0', '-1', '1.5', '01', '97, 98', ''])(
    'returns 400 when excludeProjectIds is %j',
    async (excludeProjectIds) => {
      asAuthenticatedUser();

      const res = await server.request(
        `/users/1/chapter-assignments/all?excludeProjectIds=${encodeURIComponent(excludeProjectIds)}`,
        { method: 'GET' }
      );

      expect(res.status).toBe(400);
      expect(getChapterAssignmentsByUserId).not.toHaveBeenCalled();
    }
  );
});
