import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as userService from './users.service';
import { updateActiveOrgRequestSchema } from './users.types';

// ─── PATCH /users/me/active-org ───────────────────────────────────────────────

const updateActiveOrgRoute = createRoute({
  tags: ['Users'],
  method: 'patch',
  path: '/users/me/active-org',
  middleware: [authenticateUser] as const,
  request: {
    body: jsonContent(updateActiveOrgRequestSchema, 'The active org to set'),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      description: 'Active org updated',
    },
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'User does not belong to this organization'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Update active organization',
  description: 'Sets the active organization for the current session and updates the user default.',
});

server.openapi(updateActiveOrgRoute, async (c) => {
  const { orgId } = c.req.valid('json');
  const currentUser = c.get('user')!;
  const session = c.get('session')!;

  // Verify the user actually belongs to this org
  const belongsToOrg = currentUser.grants.some((g) => g.orgId === orgId);
  if (!belongsToOrg) {
    return c.json(
      { message: 'User does not belong to this organization' },
      HttpStatusCodes.FORBIDDEN
    );
  }

  const result = await userService.setActiveOrg(currentUser.id, session.session.id, orgId);
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  return c.body(null, HttpStatusCodes.OK);
});
