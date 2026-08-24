import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppEnv } from '@/server/context.types';

import { ProjectPolicy } from '@/domains/projects/project.policy';
import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';

/**
 * Ensures the caller may read the project that owns the given project unit, so
 * USFM export endpoints cannot expose another organization's translated content.
 * Mirrors the read path in translated-verse-auth.middleware.ts and returns 404
 * (not 403) on any failure to avoid project-unit enumeration. Requires
 * authenticateUser to have run first.
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

    const projectUnitId = Number(c.req.param(paramName));
    if (!Number.isInteger(projectUnitId) || projectUnitId <= 0) {
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    const unitResult = await projectService.getProjectIdByUnitId(projectUnitId);
    if (!unitResult.ok) {
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    const projectResult = await projectService.getProjectById(unitResult.data.projectId);
    if (!projectResult.ok) {
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
