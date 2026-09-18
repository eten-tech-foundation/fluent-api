import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import * as milestonesService from '@/domains/milestones/milestones.service';
import { milestoneResponseSchema } from '@/domains/milestones/milestones.types';
import * as projectsService from '@/domains/projects/projects.service';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission, requireSelf } from '@/middlewares/role-auth';
import { server } from '@/server/server';

const getUserMilestonesRoute = createRoute({
  tags: ['Milestones'],
  method: 'get',
  path: '/users/{userId}/milestones',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireSelf(),
  ] as const,
  request: {
    params: z.object({
      userId: z.coerce
        .number()
        .int()
        .positive()
        .openapi({
          param: { name: 'userId', in: 'path', required: true },
          example: 1,
        }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      milestoneResponseSchema.array().openapi('UserMilestones'),
      'Milestones across projects the user can access'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'You can only access your own resources'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get milestones for a user',
  description:
    'Flat list of milestones for every project the user belongs to. Same membership rules as GET /users/{userId}/projects.',
});

server.openapi(getUserMilestonesRoute, async (c) => {
  const { userId } = c.req.valid('param');
  const activeOrgId = c.get('activeOrgId');

  const projectsResult = await projectsService.getProjectsByUserId(
    userId,
    activeOrgId ?? undefined
  );
  if (!projectsResult.ok) {
    return c.json(
      { message: projectsResult.error.message },
      getHttpStatus(projectsResult.error) as never
    );
  }

  const projectIds = projectsResult.data.map((p) => p.id);
  const result = await milestonesService.listMilestonesForProjects(projectIds);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
