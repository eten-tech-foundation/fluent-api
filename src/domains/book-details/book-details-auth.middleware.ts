import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppEnv } from '@/server/context.types';

import { ProjectPolicy } from '@/domains/projects/project.policy';
import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { MAX_POSTGRES_INT } from '@/lib/constants';
import { getHttpStatus } from '@/lib/types';

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
 * Returns 404 rather than 403 on authorization denials, so a caller cannot enumerate project units by
 * watching the status change. Malformed IDs return 400 and lookup/database failures return their own status (500).
 * Requires `authenticateUser` to have run first.
 */
export function requireBookDetailsAccess(paramName = 'projectUnitId') {
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
    // Guard against values exceeding PostgreSQL's 32-bit signed integer capacity (SQLSTATE 22P02 overflow).
    if (
      !Number.isInteger(projectUnitId) ||
      projectUnitId <= 0 ||
      projectUnitId > MAX_POSTGRES_INT
    ) {
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
