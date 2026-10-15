import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserResponse } from '@/domains/users/users.types';
import type { Permission } from '@/lib/permissions';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getProjectsByUserId } from '@/domains/users/projects/user-projects.service';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import './self-projects.route';

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

function asAuthenticatedUser(user: UserResponse = APP_USER, permissions: Permission[] = []) {
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
      name: user.username,
      email: user.email,
      emailVerified: true,
      banned: false,
      twoFactorEnabled: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  vi.mocked(getUserByEmail).mockResolvedValue(ok(user));
  vi.mocked(findGrantsByUserId).mockResolvedValue(
    ok([{ orgId: 1, projectId: null, permissions: new Set(permissions) }])
  );
}

describe('get /self/projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    const res = await server.request('/self/projects', { method: 'GET' });

    expect(res.status).toBe(401);
    expect(getProjectsByUserId).not.toHaveBeenCalled();
  });

  it('returns 403 User account is inactive and does not call the service', async () => {
    asAuthenticatedUser({ ...APP_USER, status: 'inactive' });

    const res = await server.request('/self/projects', { method: 'GET' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'User account is inactive' });
    expect(getProjectsByUserId).not.toHaveBeenCalled();
  });

  it('returns 200 [] without project:view and calls the service with the session user', async () => {
    asAuthenticatedUser();
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([]));

    const res = await server.request('/self/projects', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(getProjectsByUserId).toHaveBeenCalledWith(1, 1, undefined);
  });

  it('forwards the optional role query to getProjectsByUserId', async () => {
    asAuthenticatedUser();
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([]));

    const res = await server.request('/self/projects?role=Project%20Observer', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(getProjectsByUserId).toHaveBeenCalledWith(1, 1, 'Project Observer');
  });

  it('returns the projects service error status', async () => {
    asAuthenticatedUser();
    vi.mocked(getProjectsByUserId).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    const res = await server.request('/self/projects', { method: 'GET' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: 'An unexpected error occurred' });
  });
});
