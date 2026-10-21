import { createRoute } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

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
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'User does not belong to this organization'
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

  // Update session and user default atomically in a single transaction
  await db.transaction(async (tx) => {
    await tx
      .update(schema.authSession)
      .set({ activeOrgId: orgId })
      .where(eq(schema.authSession.id, session.session.id));

    await tx
      .update(schema.users)
      .set({ lastActiveOrgId: orgId })
      .where(eq(schema.users.id, currentUser.id));
  });

  return c.body(null, HttpStatusCodes.OK);
});
