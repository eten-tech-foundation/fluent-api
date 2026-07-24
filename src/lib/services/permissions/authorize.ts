import type { Permission } from '@/lib/permissions';
import type { AppPolicyUser, AuthScope, Grant } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { ROLES } from '@/lib/roles';

/**
 * A grant applies to a request scope when:
 *  - it is global (org + project both null) — SuperAdmin; OR
 *  - the request is project-scoped (projectId given) and the grant is either
 *    pinned to that project, or an org-wide role over that project's org; OR
 *  - the request is org-scoped (no project) and the grant is an org-wide grant
 *    (grant.projectId === null). Project-pinned grants never satisfy org-scoped
 *    checks — a translator pinned to project 10 must not gain org:create.
 */
function isGrantApplicable(grant: Grant, orgId: number | null, projectId: number | null): boolean {
  if (grant.orgId === null && grant.projectId === null) return true;

  if (projectId !== null) {
    if (grant.projectId === projectId && grant.orgId === orgId) return true;
    if (grant.projectId === null && grant.orgId === orgId) return true;
    return false;
  }

  if (orgId !== null) {
    return grant.orgId === orgId && grant.projectId === null;
  }

  return false;
}

export function collectPermissions(grants: Grant[], scope: AuthScope): Set<Permission> {
  const orgId = scope.orgId ?? null;
  const projectId = scope.projectId ?? null;
  const out = new Set<Permission>();
  for (const grant of grants) {
    if (isGrantApplicable(grant, orgId, projectId)) {
      for (const permission of grant.permissions) out.add(permission);
    }
  }
  return out;
}

export function authorize(user: AppPolicyUser, permission: Permission, scope: AuthScope): boolean {
  return collectPermissions(user.grants, scope).has(permission);
}

/**
 * Validates that the caller has sufficient role-granting permissions
 * to assign targetRoleName in the specified organization and project scope.
 */
export function canAssignRole(
  caller: AppPolicyUser,
  targetRoleName: string,
  orgId: number,
  projectId: number | null
): boolean {
  const scope = { orgId, projectId };

  // 1. SuperAdmin role can only be assigned by a global SuperAdmin
  if (targetRoleName === ROLES.SUPER_ADMIN) {
    return (
      authorize(caller, PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER, { orgId: null, projectId: null }) &&
      caller.grants.some((g) => g.orgId === null && g.projectId === null)
    );
  }

  // 2. Org Owner role can only be assigned by a SuperAdmin or an Org Owner of this org
  if (targetRoleName === ROLES.ORG_OWNER) {
    const hasOrgAssign = authorize(caller, PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER, scope);
    if (!hasOrgAssign) return false;
    return caller.grants.some(
      (g) =>
        (g.orgId === null && g.projectId === null) || (g.orgId === orgId && g.projectId === null)
    );
  }

  // 3. Org Manager role requires ROLE_ASSIGN_ORG_MANAGER permission
  if (targetRoleName === ROLES.ORG_MANAGER) {
    return authorize(caller, PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER, scope);
  }

  // 4. Org Member role requires USER_CREATE, ROLE_ASSIGN_PROJECT, or ROLE_ASSIGN_ORG_MANAGER permission
  if (targetRoleName === ROLES.ORG_MEMBER) {
    return (
      authorize(caller, PERMISSIONS.USER_CREATE, scope) ||
      authorize(caller, PERMISSIONS.ROLE_ASSIGN_PROJECT, scope) ||
      authorize(caller, PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER, scope)
    );
  }

  // 5. Project-level roles (Project Manager, Translator, Observer) require ROLE_ASSIGN_PROJECT permission
  if (
    targetRoleName === ROLES.PROJECT_MANAGER ||
    targetRoleName === ROLES.PROJECT_TRANSLATOR ||
    targetRoleName === ROLES.PROJECT_OBSERVER
  ) {
    if (projectId === null) return false;
    return authorize(caller, PERMISSIONS.ROLE_ASSIGN_PROJECT, scope);
  }

  return false;
}
