import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';

import {
  inactiveAccountResponse,
  internalErrorResponse,
  unauthorizedResponse,
} from '@/domains/self/self-responses';
import * as userProjectsService from '@/domains/users/projects/user-projects.service';
import { userProjectResponseSchema } from '@/domains/users/projects/user-projects.types';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

const getSelfProjectsRoute = createRoute({
  tags: ['Self - Projects'],
  method: 'get',
  path: '/self/projects',
  middleware: [authenticateUser] as const,
  request: {
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
      userProjectResponseSchema.array(),
      'Projects the current user is a member of. Empty when the user is in no project.'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: inactiveAccountResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
  summary: 'Get projects for the current user',
  description:
    'Session-scoped list of projects for the authenticated user. Authenticates only; a caller in no project receives 200 [].',
});

server.openapi(getSelfProjectsRoute, async (c) => {
  const { role } = c.req.valid('query');
  const currentUser = c.get('user')!;
  const activeOrgId = c.get('activeOrgId');

  const result = await userProjectsService.getProjectsByUserId(
    currentUser.id,
    activeOrgId ?? undefined,
    role
  );
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
