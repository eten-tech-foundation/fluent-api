import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppEnv } from '@/server/context.types';

import { ProjectPolicy } from '@/domains/projects/project.policy';
import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { getHttpStatus } from '@/lib/types';

/**
 * Ensures the caller may read the project that owns the given project unit, so
 * USFM export endpoints cannot expose another organization's translated content.
 * Mirrors the read path in translated-verse-auth.middleware.ts and returns 404
 * (not 403) on any authorization denial to avoid project-unit enumeration.
 * Malformed IDs return 400 and lookup/database failures return their own status (500).
 * Requires authenticateUser to have run first.
 *
 * On success, sets `project` and `projectAuthContext` on the context so handlers
 * can reuse them without re-querying.
 */
export function requireProjectUnitAccess(paramName = 'projectUnitId') {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user')!;
    const policyUser = {
      id: user.id,
      grants: user.grants,
    };

    const rawParam = c.req.param(paramName);
    if (!rawParam || !/^\d+$/.test(rawParam)) {
      return c.json({ message: `Missing ${paramName}` }, HttpStatusCodes.BAD_REQUEST);
    }

    const projectUnitId = Number(rawParam);
    if (!Number.isInteger(projectUnitId) || projectUnitId <= 0 || projectUnitId > 2147483647) {
      return c.json({ message: `Missing ${paramName}` }, HttpStatusCodes.BAD_REQUEST);
    }

    const unitResult = await projectService.getProjectIdByUnitId(projectUnitId);
    if (!unitResult.ok) {
      const status = getHttpStatus(unitResult.error);
      if (status !== HttpStatusCodes.NOT_FOUND) {
        return c.json({ message: unitResult.error.message }, status as never);
      }
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    const projectResult = await projectService.getProjectById(unitResult.data.projectId);
    if (!projectResult.ok) {
      const status = getHttpStatus(projectResult.error);
      if (status !== HttpStatusCodes.NOT_FOUND) {
        return c.json({ message: projectResult.error.message }, status as never);
      }
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    const isProjectMember = await resolveIsProjectMember(unitResult.data.projectId, user.id);

    if (!ProjectPolicy.read(policyUser, projectResult.data, isProjectMember)) {
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    c.set('project', projectResult.data);
    c.set('projectAuthContext', { isProjectMember });

    return next();
  });
}
