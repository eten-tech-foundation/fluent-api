import type { UserResponse } from '@/domains/users/users.types';
import type { Result } from '@/lib/types';

import { findUserIdsInOrg } from '@/domains/user-roles/user-roles.repository';
import * as usersService from '@/domains/users/users.service';
import { err, ErrorCode } from '@/lib/types';

import * as repo from './org-users.repository';

/**
 * Changes a member's org-level role.
 *
 * Callers must pass the authorization checks before reaching this service
 * (org-scoped user:update middleware + canAssignRole in the route). This layer
 * enforces the remaining invariants:
 *
 * - A user may not change their own org-level role (D2). An Org Manager can
 *   only be demoted by a *different* Org Manager, which guarantees the org
 *   always retains at least one.
 * - The target must already belong to the org (any grant row counts as
 *   membership, matching addProjectUsers' check).
 */
export async function updateOrgUserRole(
  callerId: number,
  orgId: number,
  userId: number,
  roleId: number
): Promise<Result<UserResponse>> {
  if (callerId === userId) {
    return err(ErrorCode.FORBIDDEN);
  }

  const memberIds = await findUserIdsInOrg(orgId, [userId]);
  if (!memberIds.has(userId)) {
    return err(ErrorCode.USER_NOT_IN_ORGANIZATION);
  }

  const result = await repo.updateOrgUserRole(orgId, userId, roleId, callerId);
  if (!result.ok) return result;

  return usersService.getUserById(userId);
}
