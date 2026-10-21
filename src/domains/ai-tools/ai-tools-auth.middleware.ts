import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppEnv } from '@/server/context.types';

import { ProjectPolicy } from '@/domains/projects/project.policy';
import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';

/**
 * Middleware that ensures the caller has access to read the project that owns
 * the request's `project_unit_id`, matching ProjectPolicy.read().
 *
 * The client sends a `project_units.id`; we resolve it to the owning
 * `projects.id` here and run the policy against THAT project (#420). Treating
 * the unit id as a project id both 404'd real requests and, on a coincidental
 * id collision, evaluated access against the wrong project.
 *
 * Returns 400 when `project_unit_id` is missing/malformed (this runs before the
 * route's Zod validator), and 404 on any unknown unit/project or unauthorized
 * access to prevent enumeration. On success, sets `project` for the handler.
 */
export function requireAiToolsAccess() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user')!;
    const policyUser = { id: user.id, grants: user.grants };

    let body: any = {};
    try {
      body =
        (c.req as any).valid?.('json') ??
        (await c.req.raw
          .clone()
          .json()
          .catch(() => ({})));
    } catch {
      body = await c.req.raw
        .clone()
        .json()
        .catch(() => ({}));
    }
    const projectUnitId = body?.project_unit_id;

    if (!Number.isInteger(projectUnitId) || projectUnitId <= 0) {
      return c.json({ message: 'Missing project_unit_id' }, HttpStatusCodes.BAD_REQUEST);
    }

    const unitResult = await projectService.getProjectIdByUnitId(projectUnitId);
    if (!unitResult.ok) {
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    const { projectId } = unitResult.data;

    const projectResult = await projectService.getProjectById(projectId);
    if (!projectResult.ok) {
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    const isProjectMember = await resolveIsProjectMember(projectId, user.id);

    if (!ProjectPolicy.read(policyUser, projectResult.data, isProjectMember)) {
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    c.set('project', projectResult.data);

    return next();
  });
}
