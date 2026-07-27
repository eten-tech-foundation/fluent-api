import type { Context, Next } from 'hono';

import { HTTPException } from 'hono/http-exception';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { Permission } from '@/lib/permissions';
import type { AppBindings, AuthScope } from '@/lib/types';

import { authorize } from '@/lib/services/permissions/authorize';

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
/** Extracts the scope an action is evaluated against from the request context. */
export type ScopeResolver = (c: Context<AppBindings>) => AuthScope | Promise<AuthScope>;

export function requirePermission(permission: Permission, resolveScope?: ScopeResolver) {
  return async (c: Context<AppBindings>, next: Next) => {
    const user = c.get('user');

    if (!user) {
      throw new HTTPException(HttpStatusCodes.UNAUTHORIZED, {
        message: 'User not authenticated',
      });
    }

    const scope: AuthScope = resolveScope ? await resolveScope(c) : {};
    const policyUser = { id: user.id, grants: user.grants };

    const isAuthorized = resolveScope
      ? authorize(policyUser, permission, scope)
      : user.grants.some((g) => g.permissions.has(permission));

    if (!isAuthorized) {
      throw new HTTPException(HttpStatusCodes.FORBIDDEN, {
        message: 'Insufficient permissions',
      });
    }

    await next();
  };
}

/** Scope from a numeric `orgId` (or `organization`) and optional `projectId` field in the JSON body. */
export const orgFromBody: ScopeResolver = async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const orgId = Number(body?.orgId ?? body?.organization);
  const projectId = Number(body?.projectId);
  return {
    ...(Number.isFinite(orgId) ? { orgId } : {}),
    ...(Number.isFinite(projectId) ? { projectId } : {}),
  };
};

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

/**
 * 4. SuperAdmin-Only Middleware
 * Relies on authenticateUser running first. Checks if the user is a global SuperAdmin.
 */
export async function requireSuperAdmin(c: any, next: any) {
  const user = c.get('user');

  if (!user) {
    throw new HTTPException(HttpStatusCodes.UNAUTHORIZED, {
      message: 'User not authenticated',
    });
  }

  // A SuperAdmin must have a global grant (orgId=null, projectId=null)
  // AND hold a SuperAdmin-exclusive permission (role:assign:org_manager).
  // Checking scope alone would let any future global read-only role pass.
  const isSuperAdmin = user.grants.some(
    (g: any) =>
      g.orgId === null && g.projectId === null && g.permissions.has('role:assign:org_manager')
  );

  if (!isSuperAdmin) {
    throw new HTTPException(HttpStatusCodes.FORBIDDEN, {
      message: 'SuperAdmin access required',
    });
  }

  await next();
}
