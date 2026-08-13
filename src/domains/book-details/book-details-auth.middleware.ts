import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppEnv } from '@/server/context.types';

import { ProjectPolicy } from '@/domains/projects/project.policy';
import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';

/**
 * Ensures the caller may read the project that owns the given project unit, so book-level fields
 * cannot be read or written across organizations.
 *
 * This domain owns its own copy rather than importing usfm's: export generation and book metadata
 * authoring are unrelated features, and reaching into another domain's middleware couples them for
 * no reason beyond the checks happening to look alike today. `translated-verses` and `usfm` each
 * carry their own for the same reason. If the three ever need to converge, that is a deliberate
 * move into shared infrastructure, not something to inherit by accident.
 *
 * Returns 404 rather than 403 on every failure, so a caller cannot enumerate project units by
 * watching the status change. Requires `authenticateUser` to have run first.
 */
export function requireBookDetailsAccess(paramName = 'projectUnitId') {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user')!;
    const policyUser = {
      id: user.id,
      role: user.role,
      roleName: user.roleName,
      organization: user.organization,
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

    const isProjectMember = await resolveIsProjectMember(
      unitResult.data.projectId,
      user.id,
      user.roleName
    );

    if (!ProjectPolicy.read(policyUser, projectResult.data, isProjectMember)) {
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    c.set('project', projectResult.data);
    c.set('projectAuthContext', { isProjectMember });

    return next();
  });
}
