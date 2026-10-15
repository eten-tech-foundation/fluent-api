import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';

import {
  inactiveAccountResponse,
  internalErrorResponse,
  unauthorizedResponse,
} from '@/domains/self/self-responses';
import * as userMilestonesService from '@/domains/users/milestones/user-milestones.service';
import { userMilestoneResponseSchema } from '@/domains/users/milestones/user-milestones.types';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

const getSelfMilestonesRoute = createRoute({
  tags: ['Self - Milestones'],
  method: 'get',
  path: '/self/milestones',
  middleware: [authenticateUser] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userMilestoneResponseSchema.array(),
      'Milestones across projects the current user belongs to. Empty when the user is in no project.'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: inactiveAccountResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
  summary: 'Get milestones for the current user',
  description:
    'Session-scoped flat list of milestones for the authenticated user. Authenticates only; a caller in no project receives 200 [].',
});

server.openapi(getSelfMilestonesRoute, async (c) => {
  const currentUser = c.get('user')!;
  const activeOrgId = c.get('activeOrgId');

  const result = await userMilestonesService.getMilestonesByUserId(
    currentUser.id,
    activeOrgId ?? undefined
  );
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
