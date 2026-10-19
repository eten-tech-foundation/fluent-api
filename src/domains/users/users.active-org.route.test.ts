import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserResponse } from '@/domains/users/users.types';
import type { Permission } from '@/lib/permissions';
import type { Grant } from '@/lib/types';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { ok } from '@/lib/types';
import { server } from '@/server/server';
import '@/domains/users/users.active-org.route';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

const mockTxUpdateWhere = vi.fn().mockResolvedValue([]);
const mockTxUpdateSet = vi.fn().mockReturnValue({ where: mockTxUpdateWhere });
const mockTxUpdate = vi.fn().mockReturnValue({ set: mockTxUpdateSet });
const mockTx = {
  update: mockTxUpdate,
};

vi.mock('@/db', () => {
  const mockQueryBuilder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ activeOrgId: 1 }]),
  };
  return {
    db: {
      select: vi.fn(() => mockQueryBuilder),
      transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    },
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const grant = (orgId: number | null): Grant => ({
  orgId,
  projectId: null,
  permissions: new Set<Permission>(),
});

const APP_USER: UserResponse = {
  id: 42,
  email: 'tester@example.com',
  username: 'tester',
  firstName: 'Test',
  lastName: 'User',
  createdBy: null,
  status: 'verified',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  lastActiveOrgId: 1,
};

function authenticateAs(user: UserResponse | null, grants: Grant[] = [grant(1), grant(2)]) {
  if (!user) {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    return;
  }

  const now = new Date();
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {
      id: 'session-xyz',
      userId: 'auth-user-42',
      token: 'mock-token',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 1e9),
    },
    user: {
      id: 'auth-user-42',
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
  vi.mocked(findGrantsByUserId).mockResolvedValue(ok(grants));
}

function patchActiveOrg(body: unknown) {
  return server.request('/users/me/active-org', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('pATCH /users/me/active-org', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxUpdate.mockReturnValue({ set: mockTxUpdateSet });
    mockTxUpdateSet.mockReturnValue({ where: mockTxUpdateWhere });
    mockTxUpdateWhere.mockResolvedValue([]);
  });

  describe('authentication & user status', () => {
    it('returns 401 when the caller is unauthenticated', async () => {
      authenticateAs(null);

      const res = await patchActiveOrg({ orgId: 1 });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({ message: 'User not authenticated' });
    });

    it('returns 403 when the user account is inactive', async () => {
      authenticateAs({ ...APP_USER, status: 'inactive' });

      const res = await patchActiveOrg({ orgId: 1 });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json).toEqual({ message: 'User account is inactive' });
    });
  });

  describe('request validation', () => {
    it('returns 400 when orgId is missing from the payload', async () => {
      authenticateAs(APP_USER);

      const res = await patchActiveOrg({});

      expect(res.status).toBe(400);
    });

    it('returns 400 when orgId is not an integer', async () => {
      authenticateAs(APP_USER);

      const res = await patchActiveOrg({ orgId: 'invalid' });

      expect(res.status).toBe(400);
    });
  });

  describe('organization membership guard', () => {
    it('returns 403 when the user does not belong to the requested organization', async () => {
      // User only belongs to orgId: 1
      authenticateAs(APP_USER, [grant(1)]);

      const res = await patchActiveOrg({ orgId: 99 });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json).toEqual({ message: 'User does not belong to this organization' });
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe('successful active org update', () => {
    it('updates session activeOrgId and user lastActiveOrgId atomically and returns 200', async () => {
      authenticateAs(APP_USER, [grant(1), grant(2)]);

      const res = await patchActiveOrg({ orgId: 2 });

      expect(res.status).toBe(200);
      expect(db.transaction).toHaveBeenCalledTimes(1);

      // Verify updates inside the transaction
      expect(mockTxUpdate).toHaveBeenCalledWith(schema.authSession);
      expect(mockTxUpdateSet).toHaveBeenCalledWith({ activeOrgId: 2 });

      expect(mockTxUpdate).toHaveBeenCalledWith(schema.users);
      expect(mockTxUpdateSet).toHaveBeenCalledWith({ lastActiveOrgId: 2 });
    });

    it('allows selecting any organization the user belongs to', async () => {
      authenticateAs(APP_USER, [grant(10), grant(20)]);

      const res = await patchActiveOrg({ orgId: 10 });
      expect(res.status).toBe(200);
      expect(mockTxUpdateSet).toHaveBeenCalledWith({ activeOrgId: 10 });
      expect(mockTxUpdateSet).toHaveBeenCalledWith({ lastActiveOrgId: 10 });
    });
  });
});
