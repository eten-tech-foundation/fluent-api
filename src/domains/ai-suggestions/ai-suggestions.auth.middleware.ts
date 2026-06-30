import type { Context } from 'hono';

import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppEnv } from '@/server/context.types';

import { AiSuggestionsPolicy } from './ai-suggestions.policy';
import { findProjectUnitAuthContext } from './ai-suggestions.repository';

export async function checkProjectUnitAccess(c: Context<AppEnv>, projectUnitId: number) {
  const user = c.get('user');
  if (!user) {
    return c.json({ message: 'Unauthorized' }, HttpStatusCodes.UNAUTHORIZED);
  }

  if (!projectUnitId || Number.isNaN(projectUnitId)) {
    return c.json({ message: 'Invalid project unit ID' }, HttpStatusCodes.BAD_REQUEST);
  }

  const context = await findProjectUnitAuthContext(projectUnitId);
  if (!context) {
    return c.json({ message: 'Project unit not found' }, HttpStatusCodes.NOT_FOUND);
  }

  const isAuthorized = AiSuggestionsPolicy.canAccessProjectUnit(user, context);
  if (!isAuthorized) {
    return c.json({ message: 'Forbidden' }, HttpStatusCodes.FORBIDDEN);
  }

  return null;
}

/**
 * Middleware that verifies the authenticated user has access to a specific project unit
 * according to the AI Suggestions authorization policy.
 *
 * @param getProjectUnitId A function to extract the projectUnitId from the request context
 */
export const requireProjectUnitAccess = (
  getProjectUnitId: (
    c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0]
  ) => number | Promise<number>
) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const projectUnitId = await getProjectUnitId(c);
    const accessError = await checkProjectUnitAccess(c, projectUnitId);
    if (accessError) {
      return accessError;
    }
    await next();
  });
