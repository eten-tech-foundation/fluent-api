import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { removeOrgUser } from './org-users.repository';

// ── Shared param schema ────────────────────────────────────────────────────────

const orgUserParamSchema = z.object({
  orgId: z.coerce.number().openapi({
    param: { name: 'orgId', in: 'path', required: true },
    example: 1,
  }),
  userId: z.coerce.number().openapi({
    param: { name: 'userId', in: 'path', required: true },
    example: 42,
  }),
});

// ─── DELETE /organizations/:orgId/users/:userId ────────────────────────────────

const removeOrgUserRoute = createRoute({
  tags: ['Organizations - Users'],
  method: 'delete',
  path: '/organizations/{orgId}/users/{userId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.MEMBERSHIP_REVOKE, (c) => {
      const orgId = Number(c.req.param('orgId'));
      return Number.isFinite(orgId) ? { orgId } : {};
    }),
  ] as const,
  request: { params: orgUserParamSchema },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: {
      description:
        'User fully removed from org. All chapter assignments cleared, all grants deleted.',
    },
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'User is not a member of this org'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Org Manager access required'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Remove user from org',
  description:
    'Removes a user from the org entirely. Clears all their chapter assignments across every project in the org, then deletes all their role grants (anchor + project-scoped + org-scoped). Org Manager only. The user\'s account and grants in other orgs are unaffected.',
});

server.openapi(removeOrgUserRoute, async (c) => {
  const { orgId, userId } = c.req.valid('param');

  const result = await removeOrgUser(orgId, userId);
  if (result.ok) return c.body(null, HttpStatusCodes.NO_CONTENT);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
