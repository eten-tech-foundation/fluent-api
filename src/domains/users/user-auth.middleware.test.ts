import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Grant } from '@/lib/types';
import type { AppEnv } from '@/server/context.types';

import { PERMISSIONS } from '@/lib/permissions';
import { ROLES } from '@/lib/roles';

import { requireUserAccess } from './user-auth.middleware';
import { USER_ACTIONS } from './users.types';

// The CREATE branch reads the JSON body and calls canAssignRole — no DB access —
// but the module-level imports pull in repositories, so the DB boundary is mocked.
vi.mock('@/db', () => ({
  db: {},
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/domains/user-roles/user-roles.repository', () => ({
  findOrgIdsForUser: vi.fn().mockResolvedValue([]),
}));

const ORG = 1;
const PROJ = 10;

const grant = (orgId: number | null, projectId: number | null, perms: string[]): Grant => ({
  orgId,
  projectId,
  permissions: new Set(perms) as ReadonlySet<any>,
});

// Global grant (orgId + projectId both null) holding every SuperAdmin permission.
const SUPER_ADMIN = {
  id: 1,
  status: 'verified',
  grants: [grant(null, null, Object.values(PERMISSIONS))],
};

// A Project Manager grant pinned to a single project.
const PROJECT_PINNED_PM = {
  id: 2,
  status: 'verified',
  grants: [
    grant(ORG, PROJ, [
      PERMISSIONS.USER_CREATE,
      PERMISSIONS.USER_VIEW,
      PERMISSIONS.ROLE_ASSIGN_PROJECT,
    ]),
  ],
};

function appFor(user: object) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', user as never);
    return next();
  });

  app.post('/users/invite', requireUserAccess(USER_ACTIONS.CREATE), (c) =>
    c.json({ reached: true })
  );

  return app;
}

function postInvite(user: object, body: object) {
  return appFor(user).request('/users/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('requireUserAccess(USER_ACTIONS.CREATE)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets a global SuperAdmin invite an Org Manager into an org', async () => {
    const res = await postInvite(SUPER_ADMIN, {
      orgId: ORG,
      projectId: null,
      roleName: ROLES.ORG_MANAGER,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
  });

  it('forbids a project-pinned Project Manager from inviting an Org Manager', async () => {
    const res = await postInvite(PROJECT_PINNED_PM, {
      orgId: ORG,
      projectId: null,
      roleName: ROLES.ORG_MANAGER,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: 'Forbidden: Insufficient privileges to assign this role.',
    });
  });
});
