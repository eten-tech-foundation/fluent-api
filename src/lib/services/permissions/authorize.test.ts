import { describe, expect, it } from 'vitest';

import type { Grant } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { ROLES } from '@/lib/roles';

import { authorize, canAssignRole, collectPermissions } from './authorize';

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

  it('project-pinned grant does NOT satisfy an org-scoped action (create project)', () => {
    // A user pinned to a single project must not gain org-wide create via that grant.
    // This was regressed in 27719f5 and re-fixed here (original fix: 10df565).
    const user = { id: 1, grants: [grant(ORG, PROJ, [PERMISSIONS.PROJECT_CREATE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_CREATE, { orgId: ORG })).toBe(false);
  });

  it('org-wide grant (projectId=null) satisfies an org-scoped action (create project)', () => {
    const user = { id: 1, grants: [grant(ORG, null, [PERMISSIONS.PROJECT_CREATE])] };
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

  it('multi-org user grants do not cross-pollinate', () => {
    const user = {
      id: 1,
      grants: [
        grant(ORG, null, [PERMISSIONS.PROJECT_CREATE]), // Manager in ORG
        grant(OTHER_ORG, OTHER_PROJ, [PERMISSIONS.CONTENT_UPDATE]), // Translator in OTHER_ORG
      ],
    };

    // User can create projects in ORG
    expect(authorize(user, PERMISSIONS.PROJECT_CREATE, { orgId: ORG })).toBe(true);

    // User cannot create projects in OTHER_ORG
    expect(authorize(user, PERMISSIONS.PROJECT_CREATE, { orgId: OTHER_ORG })).toBe(false);

    // User can update content in OTHER_ORG's PROJ
    expect(
      authorize(user, PERMISSIONS.CONTENT_UPDATE, { orgId: OTHER_ORG, projectId: OTHER_PROJ })
    ).toBe(true);

    // User cannot update content in ORG's project
    expect(authorize(user, PERMISSIONS.CONTENT_UPDATE, { orgId: ORG, projectId: PROJ })).toBe(
      false
    );
  });
});

describe('canAssignRole', () => {
  const ORG = 1;
  const PROJ = 10;

  // Helper: a global SuperAdmin with all relevant permissions
  const superAdmin = {
    id: 1,
    grants: [
      grant(null, null, [PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER, PERMISSIONS.ROLE_ASSIGN_PROJECT]),
    ],
  };

  // Helper: an org-level PM with project-assign permissions
  const orgPM = {
    id: 2,
    grants: [grant(ORG, null, [PERMISSIONS.ROLE_ASSIGN_PROJECT])],
  };

  // Helper: a project-pinned translator with no assign permissions
  const translator = {
    id: 3,
    grants: [grant(ORG, PROJ, [PERMISSIONS.CONTENT_UPDATE])],
  };

  it('only a global SuperAdmin can assign SuperAdmin role', () => {
    expect(canAssignRole(superAdmin, ROLES.SUPER_ADMIN, ORG, null)).toBe(true);
    expect(canAssignRole(orgPM, ROLES.SUPER_ADMIN, ORG, null)).toBe(false);
  });

  it('superAdmin can assign Org Owner', () => {
    expect(canAssignRole(superAdmin, ROLES.ORG_OWNER, ORG, null)).toBe(true);
  });

  it('org PM without ROLE_ASSIGN_ORG_MANAGER cannot assign Org Owner', () => {
    expect(canAssignRole(orgPM, ROLES.ORG_OWNER, ORG, null)).toBe(false);
  });

  it('superAdmin can assign Org Manager', () => {
    expect(canAssignRole(superAdmin, ROLES.ORG_MANAGER, ORG, null)).toBe(true);
  });

  it('org PM with ROLE_ASSIGN_PROJECT can assign Project Manager', () => {
    expect(canAssignRole(orgPM, ROLES.PROJECT_MANAGER, ORG, PROJ)).toBe(true);
  });

  it('org PM with ROLE_ASSIGN_PROJECT can assign Project Translator', () => {
    expect(canAssignRole(orgPM, ROLES.PROJECT_TRANSLATOR, ORG, PROJ)).toBe(true);
  });

  it('translator without assign permissions cannot assign any role', () => {
    expect(canAssignRole(translator, ROLES.PROJECT_MANAGER, ORG, PROJ)).toBe(false);
    expect(canAssignRole(translator, ROLES.PROJECT_TRANSLATOR, ORG, PROJ)).toBe(false);
    expect(canAssignRole(translator, ROLES.ORG_MANAGER, ORG, null)).toBe(false);
  });

  it('unknown role name is always denied', () => {
    expect(canAssignRole(superAdmin, 'NonExistentRole', ORG, null)).toBe(false);
  });

  it('assigning a project-scoped role without providing a projectId is denied', () => {
    expect(canAssignRole(superAdmin, ROLES.PROJECT_MANAGER, ORG, null)).toBe(false);
    expect(canAssignRole(orgPM, ROLES.PROJECT_MANAGER, ORG, null)).toBe(false);
  });

  it('a project-pinned assign grant cannot assign into a different project or different org', () => {
    const PROJ2 = 20;
    const ORG2 = 2;
    const projectPM = {
      id: 4,
      grants: [grant(ORG, PROJ, [PERMISSIONS.ROLE_ASSIGN_PROJECT])],
    };
    expect(canAssignRole(projectPM, ROLES.PROJECT_MANAGER, ORG, PROJ2)).toBe(false);
    expect(canAssignRole(projectPM, ROLES.PROJECT_MANAGER, ORG2, PROJ)).toBe(false);
  });
});
