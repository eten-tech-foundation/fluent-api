import { createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { findOrgIdsForUser } from '@/domains/user-roles/user-roles.repository';
import { ZOD_ERROR_CODES, ZOD_ERROR_MESSAGES } from '@/lib/constants';
import { PERMISSIONS } from '@/lib/permissions';
import {
  createUserWithInvitation,
  inviteExistingUserToOrg,
} from '@/lib/services/auth/auth.service';
import { authorize } from '@/lib/services/permissions/authorize';
import { ErrorCode, ErrorMessages, getHttpStatus } from '@/lib/types';
import { authenticateUser, orgFromBody, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireUserAccess } from './user-auth.middleware';
import { UserPolicy } from './user.policy';
import * as userService from './users.service';
import {
  createUserRequestSchema,
  inviteUserRequestSchema,
  updateActiveOrgRequestSchema,
  updateUserRequestSchema,
  USER_ACTIONS,
  userResponseSchema,
} from './users.types';

// ─── GET /users ───────────────────────────────────────────────────────────────

const listUsersRoute = createRoute({
  tags: ['Users'],
  method: 'get',
  path: '/users',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.USER_VIEW),
    requireUserAccess(USER_ACTIONS.LIST),
  ] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userResponseSchema.array().openapi('Users'),
      'The list of users within the organization'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get all users',
  description: "Returns a list of users within the manager's organization. Project Manager only.",
});

server.openapi(listUsersRoute, async (c) => {
  const currentUser = c.get('user')!;

  const result = await userService.getUsersForUser({
    id: currentUser.id,
    grants: currentUser.grants,
  });
  if (result.ok) {
    return c.json(result.data, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── POST /users ──────────────────────────────────────────────────────────────

const createUserRoute = createRoute({
  tags: ['Users'],
  method: 'post',
  path: '/users',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.USER_CREATE, orgFromBody),
    requireUserAccess(USER_ACTIONS.CREATE),
  ] as const,
  request: {
    body: jsonContent(createUserRequestSchema, 'The user to create'),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(userResponseSchema, 'The created user'),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('Conflict'),
      'Username or Email already exists'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Validation error'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      z.object({
        success: z.boolean(),
        error: z.object({
          issues: z.array(
            z.object({ code: z.string(), path: z.array(z.string()), message: z.string() })
          ),
          name: z.string(),
        }),
      }),
      'The validation error'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema('Internal Server Error'),
      'Internal server error'
    ),
  },
  summary: 'Create a new user',
  description: 'Creates a new user with the provided data. Project Manager only.',
});

server.openapi(createUserRoute, async (c) => {
  const requestData = c.req.valid('json');
  const currentUser = c.get('user')!;

  const result = await userService.createUser(requestData);
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  // Grant the new user their initial role via user_roles
  if (requestData.orgId) {
    try {
      const { grantRole } = await import('@/domains/user-roles/user-roles.service');

      const grantResult = await grantRole({
        userId: result.data.id,
        orgId: requestData.orgId,
        projectId: requestData.projectId ?? null,
        roleId: requestData.roleId,
        createdBy: currentUser.id,
      });
      if (!grantResult.ok) {
        const deleteResult = await userService.deleteUser(result.data.id);
        const rollbackMsg = !deleteResult.ok
          ? ` (Rollback failed: ${deleteResult.error.message})`
          : '';
        return c.json(
          {
            message: `Failed to create initial role grant: ${grantResult.error.message}${rollbackMsg}`,
          },
          HttpStatusCodes.INTERNAL_SERVER_ERROR
        );
      }
    } catch (error) {
      const deleteResult = await userService.deleteUser(result.data.id);
      const rollbackMsg = !deleteResult.ok
        ? ` (Rollback failed: ${deleteResult.error.message})`
        : '';
      const errorMessage = error instanceof Error ? error.message : 'Grant failed';
      return c.json(
        { message: `Failed to create initial role grant: ${errorMessage}${rollbackMsg}` },
        HttpStatusCodes.INTERNAL_SERVER_ERROR
      );
    }
  }

  return c.json(result.data, HttpStatusCodes.CREATED);
});

// ─── POST /users/invite ───────────────────────────────────────────────────────

const createUserWithInvitationRoute = createRoute({
  tags: ['Users'],
  method: 'post',
  path: '/users/invite',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.USER_CREATE, orgFromBody),
    requireUserAccess(USER_ACTIONS.CREATE),
  ] as const,
  request: {
    body: jsonContent(inviteUserRequestSchema, 'The user to invite'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ user: userResponseSchema }),
      'Existing user added to org and project — login link email sent'
    ),
    [HttpStatusCodes.CREATED]: jsonContent(
      z.object({ user: userResponseSchema }),
      'New user created and magic link invitation sent'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('Conflict'),
      'Username or Email already exists'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Validation error or auth error'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      z.object({
        success: z.boolean(),
        error: z.object({
          issues: z.array(
            z.object({ code: z.string(), path: z.array(z.string()), message: z.string() })
          ),
          name: z.string(),
        }),
      }),
      'The validation error'
    ),
  },
  summary: 'Create user and send invitation',
  description: 'Creates a new user in database and sends magic link invitation email',
});

server.openapi(createUserWithInvitationRoute, async (c) => {
  const { email, username, orgId, projectId, roleId, orgName, inviterName } = c.req.valid('json');
  const caller = c.get('user')!;
  const normalizedEmail = email.toLowerCase();

  // Check if the user already exists in the system
  const existingUserResult = await userService.getUserByEmail(normalizedEmail);

  if (existingUserResult.ok) {
    // ── EXISTING USER PATH ────────────────────────────────────────────────────
    // User already has a Fluent account — grant access and send login-link email.
    const result = await inviteExistingUserToOrg({
      existingUser: existingUserResult.data,
      orgId,
      projectId,
      roleId,
      createdBy: caller.id,
      orgName,
      inviterName,
    });
    if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  // ── NEW USER PATH ─────────────────────────────────────────────────────────
  // User doesn't exist yet — create account and send magic link invitation.
  const result = await createUserWithInvitation(
    { email: normalizedEmail, username, orgId, projectId, roleId, status: 'invited' },
    c.req.raw.headers
  );
  if (result.ok) return c.json(result.data, HttpStatusCodes.CREATED);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /users/email/:email ──────────────────────────────────────────────────
// Stays inline — unique email-based lookup, not ID param.

const getUserByEmailRoute = createRoute({
  tags: ['Users'],
  method: 'get',
  path: '/users/email/{email}',
  middleware: [authenticateUser] as const,
  request: {
    params: z.object({
      email: z
        .string()
        .email('Invalid email format')
        .openapi({
          param: { name: 'email', in: 'path', required: true, allowReserved: false },
          example: 'user@example.com',
        }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(userResponseSchema, 'The user'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'User not found'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
  },
  summary: 'Get a user by email',
  description: 'Managers: any user in their org. Translators: themselves only.',
});

server.openapi(getUserByEmailRoute, async (c) => {
  const { email } = c.req.valid('param');
  const currentUser = c.get('user')!;
  const policyUser = {
    id: currentUser.id,
    grants: currentUser.grants,
  };

  const result = await userService.getUserByEmail(email.toLowerCase());

  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  const targetUser = result.data;
  const targetOrgIds = await findOrgIdsForUser(targetUser.id);

  // Returning 404 instead of 403 to prevent email enumeration across orgs
  if (!UserPolicy.view(policyUser, { id: targetUser.id, orgIds: targetOrgIds })) {
    return c.json({ message: ErrorMessages[ErrorCode.USER_NOT_FOUND] }, HttpStatusCodes.NOT_FOUND);
  }

  // When the caller is fetching their own profile, inject the session-scoped
  // activeOrgId so the frontend uses the same org the backend is filtering by.
  if (targetUser.id === currentUser.id) {
    const sessionActiveOrgId = c.get('activeOrgId') as number | null;
    if (sessionActiveOrgId != null) {
      targetUser.lastActiveOrgId = sessionActiveOrgId;
    }
  }

  return c.json(targetUser, HttpStatusCodes.OK);
});

// ─── GET /users/:id ───────────────────────────────────────────────────────────

const getUserRoute = createRoute({
  tags: ['Users'],
  method: 'get',
  path: '/users/{id}',
  middleware: [authenticateUser, requireUserAccess(USER_ACTIONS.VIEW)] as const,
  request: {
    params: z.object({
      id: z.coerce.number().openapi({
        param: { name: 'id', in: 'path', required: true, allowReserved: false },
        example: 1,
      }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(userResponseSchema, 'The user'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'User not found'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
  },
  summary: 'Get a user by ID',
  description: 'Managers: any user in their org. Translators: themselves only.',
});

server.openapi(getUserRoute, async (c) => {
  const targetUser = c.get('targetUser')!;
  return c.json(targetUser, HttpStatusCodes.OK);
});

// ─── PATCH /users/:id ─────────────────────────────────────────────────────────

const updateUserRoute = createRoute({
  tags: ['Users'],
  method: 'patch',
  path: '/users/{id}',
  middleware: [authenticateUser, requireUserAccess(USER_ACTIONS.UPDATE)] as const,
  request: {
    params: z.object({
      id: z.coerce.number().openapi({
        param: { name: 'id', in: 'path', required: true, allowReserved: false },
        example: 1,
      }),
    }),
    body: jsonContent(updateUserRequestSchema, 'The user updates'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(userResponseSchema, 'The updated user'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'User not found'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('Conflict'),
      'Username or Email already exists'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Validation or constraint error'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      z.object({
        success: z.boolean(),
        error: z.object({
          issues: z.array(
            z.object({ code: z.string(), path: z.array(z.string()), message: z.string() })
          ),
          name: z.string(),
        }),
      }),
      'The validation error'
    ),
  },
  summary: 'Update a user',
  description: 'Managers: can update any user in their org. Translators: themselves only.',
});

server.openapi(updateUserRoute, async (c) => {
  const { id } = c.req.valid('param');
  const updates = c.req.valid('json');
  const currentUser = c.get('user')!;
  const targetUser = c.get('targetUser')!;

  if (Object.keys(updates).length === 0) {
    return c.json(
      {
        success: false,
        error: {
          issues: [
            {
              code: ZOD_ERROR_CODES.INVALID_UPDATES,
              path: [],
              message: ZOD_ERROR_MESSAGES.NO_UPDATES,
            },
          ],
          name: 'ZodError',
        },
      },
      HttpStatusCodes.UNPROCESSABLE_ENTITY
    );
  }

  // Strip role update if user lacks MEMBERSHIP_REVOKE
  const targetOrgIds = await findOrgIdsForUser(targetUser.id);
  const hasGrantManagement = targetOrgIds.some((orgId) =>
    authorize({ id: currentUser.id, grants: currentUser.grants }, PERMISSIONS.MEMBERSHIP_REVOKE, {
      orgId,
    })
  );

  if (!hasGrantManagement) {
    delete (updates as Record<string, unknown>).role;
  }

  const result = await userService.updateUser(id, updates);

  if (result.ok) {
    return c.json(result.data, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── DELETE /users/:id ────────────────────────────────────────────────────────

const deleteUserRoute = createRoute({
  tags: ['Users'],
  method: 'delete',
  path: '/users/{id}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.USER_DELETE),
    requireUserAccess(USER_ACTIONS.DELETE),
  ] as const,
  request: {
    params: z.object({
      id: z.coerce.number().openapi({
        param: { name: 'id', in: 'path', required: true, allowReserved: false },
        example: 1,
      }),
    }),
  },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: {
      description: 'User deleted',
    },
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'User not found'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
  },
  summary: 'Delete a user',
  description: 'Manager only. Can only delete users in their own organisation.',
});

server.openapi(deleteUserRoute, async (c) => {
  const { id } = c.req.valid('param');

  const result = await userService.deleteUser(id);

  if (result.ok) {
    return c.body(null, HttpStatusCodes.NO_CONTENT);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

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
  // eslint-disable-next-line max-lines
});
