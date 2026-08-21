import { createMiddleware } from 'hono/factory';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppEnv } from '@/server/context.types';

import { ProjectPolicy } from '@/domains/projects/project.policy';
import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';

/**
 * Middleware that ensures the caller has access to read the target project
 * for AI tool invocation, matching ProjectPolicy.read().
 * Returns 404 on any invalid project or unauthorized access to prevent enumeration.
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
    const projectId = Number(body?.project_id);

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    const projectResult = await projectService.getProjectById(projectId);
    if (!projectResult.ok) {
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    const isProjectMember = await resolveIsProjectMember(projectId, user.id);

    if (!ProjectPolicy.read(policyUser, projectResult.data, isProjectMember)) {
      return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
    }

    return next();
  });
}
