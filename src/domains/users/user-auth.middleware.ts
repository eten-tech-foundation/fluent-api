import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppEnv } from '@/server/context.types';

import type { UserAction } from './users.types';

import { UserPolicy } from './user.policy';
import * as userService from './users.service';
import { USER_ACTIONS } from './users.types';

// Loads the target user, evaluates UserPolicy, and injects the entity into context.
export function requireUserAccess(action: UserAction, paramName = 'id') {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user')!;
    const policyUser = { id: user.id, roleName: user.roleName, organization: user.organization };

    if (action === USER_ACTIONS.LIST) {
      if (!UserPolicy.list(policyUser)) {
        return c.json({ message: 'Forbidden' }, HttpStatusCodes.FORBIDDEN);
      }
      return next();
    }

    if (action === USER_ACTIONS.CREATE) {
      if (!UserPolicy.create(policyUser)) {
        return c.json({ message: 'Forbidden' }, HttpStatusCodes.FORBIDDEN);
      }
      return next();
    }

    const targetUserId = Number(c.req.param(paramName));
    if (!targetUserId || Number.isNaN(targetUserId)) {
      return c.json({ message: 'Missing user ID' }, HttpStatusCodes.BAD_REQUEST);
    }

    const result = await userService.getUserById(targetUserId);
    if (!result.ok) {
      return c.json({ message: 'User not found' }, HttpStatusCodes.NOT_FOUND);
    }

    const targetUser = result.data;
    let allowed = false;

    switch (action) {
      case USER_ACTIONS.VIEW:
        allowed = UserPolicy.view(policyUser, targetUser);
        break;

      case USER_ACTIONS.UPDATE:
        allowed = UserPolicy.update(policyUser, targetUser);
        break;

      case USER_ACTIONS.DELETE:
        allowed = UserPolicy.delete(policyUser, targetUser);
        break;
    }

    if (!allowed) {
      return c.json({ message: 'User not found' }, HttpStatusCodes.NOT_FOUND);
    }

    c.set('targetUser', targetUser);
    return next();
  });
}
