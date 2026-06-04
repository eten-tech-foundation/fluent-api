import { describe, expect, it } from 'vitest';

import type { Grant } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';

import { authorize, collectPermissions } from './authorize';

const grant = (orgId: number | null, projectId: number | null, perms: string[]): Grant => ({
  orgId,
  projectId,
  permissions: new Set(perms) as ReadonlySet<any>,
});

describe('authorize', () => {
  const ORG = 1;
  const OTHER_ORG = 2;
  const PROJ = 10;
  const OTHER_PROJ = 11;

  it('superAdmin (global grant) passes any scope', () => {
    const user = { id: 1, grants: [grant(null, null, [PERMISSIONS.PROJECT_DELETE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_DELETE, { orgId: ORG, projectId: PROJ })).toBe(true);
    expect(authorize(user, PERMISSIONS.PROJECT_DELETE, { orgId: OTHER_ORG })).toBe(true);
  });

  it('org-wide PM grant applies to any project in that org', () => {
    const user = { id: 1, grants: [grant(ORG, null, [PERMISSIONS.PROJECT_UPDATE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_UPDATE, { orgId: ORG, projectId: PROJ })).toBe(true);
    expect(authorize(user, PERMISSIONS.PROJECT_UPDATE, { orgId: ORG, projectId: OTHER_PROJ })).toBe(
      true
    );
  });

  it('project-pinned grant does NOT apply to a sibling project', () => {
    const user = { id: 1, grants: [grant(ORG, PROJ, [PERMISSIONS.PROJECT_UPDATE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_UPDATE, { orgId: ORG, projectId: PROJ })).toBe(true);
    expect(authorize(user, PERMISSIONS.PROJECT_UPDATE, { orgId: ORG, projectId: OTHER_PROJ })).toBe(
      false
    );
  });

  it('project-pinned PM grant counts for an org-scoped action (create project)', () => {
    const user = { id: 1, grants: [grant(ORG, PROJ, [PERMISSIONS.PROJECT_CREATE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_CREATE, { orgId: ORG })).toBe(true);
  });

  it('translator grant lacking project:create is denied an org-scoped create', () => {
    const user = { id: 1, grants: [grant(ORG, PROJ, [PERMISSIONS.CONTENT_UPDATE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_CREATE, { orgId: ORG })).toBe(false);
  });

  it('grants in a different org never apply', () => {
    const user = { id: 1, grants: [grant(OTHER_ORG, null, [PERMISSIONS.PROJECT_UPDATE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_UPDATE, { orgId: ORG, projectId: PROJ })).toBe(
      false
    );
  });

  it('collectPermissions unions across applicable grants', () => {
    const user = {
      id: 1,
      grants: [
        grant(ORG, null, [PERMISSIONS.PROJECT_VIEW]),
        grant(ORG, PROJ, [PERMISSIONS.CONTENT_UPDATE]),
        grant(OTHER_ORG, null, [PERMISSIONS.PROJECT_DELETE]),
      ],
    };
    const perms = collectPermissions(user.grants, { orgId: ORG, projectId: PROJ });
    expect(perms.has(PERMISSIONS.PROJECT_VIEW)).toBe(true);
    expect(perms.has(PERMISSIONS.CONTENT_UPDATE)).toBe(true);
    expect(perms.has(PERMISSIONS.PROJECT_DELETE)).toBe(false);
  });
});
