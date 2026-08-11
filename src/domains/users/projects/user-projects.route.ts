import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission, requireSelf } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as userProjectsService from './user-projects.service';
import { userProjectResponseSchema } from './user-projects.types';

const getUserProjectsRoute = createRoute({
  tags: ['Projects'],
  method: 'get',
  path: '/users/{userId}/projects',
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
    query: z.object({
      role: z
        .string()
        .optional()
        .openapi({
          param: { name: 'role', in: 'query', required: false },
          example: 'Project Observer',
          description:
            'Filter projects by the user\'s role name (e.g. "Project Observer", "Project Translator")',
        }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userProjectResponseSchema.array().openapi('UserProjects'),
      'The list of projects the user is a member of'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get projects for a user',
  description: 'Returns all projects the specified user is a member of',
});

server.openapi(getUserProjectsRoute, async (c) => {
  const { userId } = c.req.valid('param');
  const { role } = c.req.valid('query');
  const activeOrgId = c.get('activeOrgId');

  const result = await userProjectsService.getProjectsByUserId(
    userId,
    activeOrgId ?? undefined,
    role
  );
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
