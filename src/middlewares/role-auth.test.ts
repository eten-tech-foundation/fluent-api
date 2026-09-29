import { describe, expect, it, vi } from 'vitest';

import { PERMISSIONS } from '@/lib/permissions';

import { requireSuperAdmin } from './role-auth';

const grant = (orgId: number | null, projectId: number | null, perms: string[]) => ({
  orgId,
  projectId,
  permissions: new Set(perms),
});

const ctx = (user: unknown) => ({
  get: (key: string) => (key === 'user' ? user : undefined),
});

describe('requireSuperAdmin', () => {
  it('passes a global SuperAdmin grant holder', async () => {
    const user = {
      id: 1,
      grants: [grant(null, null, [PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER])],
    };
    const next = vi.fn();

    await requireSuperAdmin(ctx(user), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects an Org Manager holding org-scoped role:assign:org_manager (#337)', async () => {
    // Since #337, Org Manager holds role:assign:org_manager — but org-scoped,
    // never global. requireSuperAdmin must still reject them.
    const orgManager = {
      id: 2,
      grants: [grant(1, null, [PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER])],
    };
    const next = vi.fn();

    await expect(requireSuperAdmin(ctx(orgManager), next)).rejects.toMatchObject({
      status: 403,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request', async () => {
    const next = vi.fn();

    await expect(requireSuperAdmin(ctx(undefined), next)).rejects.toMatchObject({
      status: 401,
    });
    expect(next).not.toHaveBeenCalled();
  });
});
