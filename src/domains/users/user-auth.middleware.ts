import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppEnv } from '@/server/context.types';

import { findOrgIdsForUser } from '@/domains/user-roles/user-roles.repository';
import { getHttpStatus } from '@/lib/types';

import type { UserAction } from './users.types';

import { UserPolicy } from './user.policy';
import * as userService from './users.service';
import { USER_ACTIONS } from './users.types';

// Loads the target user, evaluates UserPolicy, and injects the entity into context.
export function requireUserAccess(action: UserAction, paramName = 'id') {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user')!;
    const policyUser = { id: user.id, grants: user.grants };

    if (action === USER_ACTIONS.LIST) {
      if (!UserPolicy.list(policyUser)) {
        return c.json({ message: 'Forbidden' }, HttpStatusCodes.FORBIDDEN);
      }
      return next();
    }

    if (action === USER_ACTIONS.CREATE) {
      const body = await c.req.json().catch(() => ({}));
      const orgId = Number(body?.orgId ?? body?.organization);
      const projectId =
        body?.projectId !== undefined && body?.projectId !== null ? Number(body.projectId) : null;

      const { ROLES } = await import('@/lib/roles');
      const { canAssignRole } = await import('@/lib/services/permissions/authorize');

      const targetRoleName = body?.roleName || ROLES.PROJECT_TRANSLATOR;

      if (!Number.isFinite(orgId)) {
        return c.json({ message: 'Missing organization ID' }, HttpStatusCodes.BAD_REQUEST);
      }

      if (!canAssignRole(policyUser, targetRoleName, orgId, projectId)) {
        return c.json(
          { message: 'Forbidden: Insufficient privileges to assign this role.' },
          HttpStatusCodes.FORBIDDEN
        );
      }
      return next();
    }

    const targetUserId = Number(c.req.param(paramName));
    if (!targetUserId || Number.isNaN(targetUserId)) {
      return c.json({ message: 'Missing user ID' }, HttpStatusCodes.BAD_REQUEST);
    }

    const result = await userService.getUserById(targetUserId);
    if (!result.ok) {
      return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
    }

    const targetUser = result.data;
    const targetOrgIds = await findOrgIdsForUser(targetUserId);
    const policyTarget = { id: targetUser.id, orgIds: targetOrgIds };

    let allowed = false;

    switch (action) {
      case USER_ACTIONS.VIEW:
        allowed = UserPolicy.view(policyUser, policyTarget);
        break;

      case USER_ACTIONS.UPDATE:
        allowed = UserPolicy.update(policyUser, policyTarget);
        break;

      case USER_ACTIONS.DELETE:
        allowed = UserPolicy.delete(policyUser, policyTarget);
        break;
    }

    if (!allowed) {
      return c.json({ message: 'User not found' }, HttpStatusCodes.NOT_FOUND);
    }

    c.set('targetUser', targetUser);
    return next();
  });
}
