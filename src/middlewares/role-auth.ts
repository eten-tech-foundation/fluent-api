import type { Context, Next } from 'hono';

import { HTTPException } from 'hono/http-exception';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { Permission } from '@/lib/permissions';
import type { AppBindings } from '@/lib/types';

import { roleHasPermission } from '@/lib/services/permissions/permissions.service';

/**
 * 1. Authentication Middleware
 * Validates the token, fetches the user, checks status, and stores in context.
 */
export async function authenticateUser(c: Context<AppBindings>, next: Next) {
  const user = c.get('user');

  if (!user) {
    throw new HTTPException(HttpStatusCodes.UNAUTHORIZED, {
      message: 'User not authenticated',
    });
  }

  if (user.status === 'inactive') {
    throw new HTTPException(HttpStatusCodes.FORBIDDEN, {
      message: 'User account is inactive',
    });
  }

  // Store user in context for downstream middlewares/handlers
  c.set('user', user);
  await next();
}

/**
 * 2. Authorization Middleware
 * Relies on authenticateUser running first. Checks if the user's role has the permission.
 */
export function requirePermission(permission: Permission) {
  return async (c: Context<AppBindings>, next: Next) => {
    const user = c.get('user');

    if (!user) {
      throw new HTTPException(HttpStatusCodes.UNAUTHORIZED, {
        message: 'User not authenticated',
      });
    }

    const granted = await roleHasPermission(user.role, permission);

    if (!granted) {
      throw new HTTPException(HttpStatusCodes.FORBIDDEN, {
        message: 'Insufficient permissions',
      });
    }

    await next();
  };
}

/**
 * 3. Self-Access Middleware
 * Ensures the authenticated user can only access their own resources.
 * Relies on authenticateUser running first.
 * Expects the route to have a `userId` path param.
 */
export function requireSelf() {
  return async (c: Context<AppBindings>, next: Next) => {
    const user = c.get('user');

    if (!user) {
      throw new HTTPException(HttpStatusCodes.UNAUTHORIZED, {
        message: 'User not authenticated',
      });
    }

    const { userId } = c.req.param();

    if (!userId || user.id !== Number(userId)) {
      throw new HTTPException(HttpStatusCodes.FORBIDDEN, {
        message: 'You can only access your own resources',
      });
    }

    await next();
  };
}
