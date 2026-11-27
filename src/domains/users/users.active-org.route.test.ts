import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserResponse } from '@/domains/users/users.types';
import type { Permission } from '@/lib/permissions';
import type { Grant, User } from '@/lib/types';

import { setActiveOrg } from '@/domains/users/users.service';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';
import '@/domains/users/users.active-org.route';

// ─── Module mocks ─────────────────────────────────────────────────────────────

const SESSION_ID = 'session-xyz';
const signedIn = vi.hoisted(() => ({ user: null as User | null }));

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

// The global authenticate middleware reads auth_session through @/db. Stub it with the
// signed-in user so this suite mocks the users service instead of @/db (FA-L7).
vi.mock('@/middlewares/authenticate', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    authenticate: createMiddleware(async (c, next) => {
      if (signedIn.user) {
        c.set('session', { session: { id: SESSION_ID } });
        c.set('user', signedIn.user);
      }
      await next();
    }),
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/users/users.service', () => ({
  setActiveOrg: vi.fn(),
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
  signedIn.user = user ? { ...user, grants } : null;
}

function patchActiveOrg(body: unknown) {
  return server.request('/users/me/active-org', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PATCH /users/me/active-org', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(setActiveOrg).mockResolvedValue(ok(undefined));
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
      expect(setActiveOrg).not.toHaveBeenCalled();
    });
  });

  describe('successful active org update', () => {
    it("sets the active org for the caller's user and session and returns 200", async () => {
      authenticateAs(APP_USER, [grant(1), grant(2)]);

      const res = await patchActiveOrg({ orgId: 2 });

      expect(res.status).toBe(200);
      expect(setActiveOrg).toHaveBeenCalledTimes(1);
      expect(setActiveOrg).toHaveBeenCalledWith(42, SESSION_ID, 2);
    });

    it('allows selecting any organization the user belongs to', async () => {
      authenticateAs(APP_USER, [grant(10), grant(20)]);

      const res = await patchActiveOrg({ orgId: 10 });

      expect(res.status).toBe(200);
      expect(setActiveOrg).toHaveBeenCalledWith(42, SESSION_ID, 10);
    });
  });

  describe('database failure', () => {
    it('returns 500 with the standard error body when the update fails', async () => {
      authenticateAs(APP_USER, [grant(1), grant(2)]);
      vi.mocked(setActiveOrg).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

      const res = await patchActiveOrg({ orgId: 2 });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json).toEqual({ message: 'An unexpected error occurred' });
    });
  });
});
