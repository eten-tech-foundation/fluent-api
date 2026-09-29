import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { getRoleId } from '@/domains/user-roles/user-roles.service';
import * as usersService from '@/domains/users/users.service';
import { userResponseSchema } from '@/domains/users/users.types';
import { PERMISSIONS } from '@/lib/permissions';
import { canAssignRole } from '@/lib/services/permissions/authorize';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { removeOrgUser } from './org-users.repository';
import { updateOrgUserRole } from './org-users.service';
import { updateOrgUserRoleBodySchema } from './org-users.types';

// ── Shared param schema ────────────────────────────────────────────────────────

const orgParamSchema = z.object({
  orgId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'orgId', in: 'path', required: true },
      example: 1,
    }),
});

const orgUserParamSchema = z.object({
  orgId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'orgId', in: 'path', required: true },
      example: 1,
    }),
  userId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'userId', in: 'path', required: true },
      example: 42,
    }),
});

// ─── GET /organizations/:orgId/users ───────────────────────────────────────────

const listOrgUsersRoute = createRoute({
  tags: ['Organizations - Users'],
  method: 'get',
  path: '/organizations/{orgId}/users',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.USER_VIEW, (c) => {
      const orgId = Number(c.req.param('orgId'));
      return Number.isFinite(orgId) ? { orgId } : {};
    }),
  ] as const,
  request: { params: orgParamSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userResponseSchema.array().openapi('OrgUsers'),
      'The list of users in this organization'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Organization not found'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Org-scoped user:view required'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'List users in an organization',
  description:
    'Returns every member of the org with their role grants filtered to this org. Requires an org-scoped or global user:view grant — a project-pinned grant does not apply.',
});

server.openapi(listOrgUsersRoute, async (c) => {
  const { orgId } = c.req.valid('param');

  const result = await usersService.getUsersInOrg(orgId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
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
    "Removes a user from the org entirely. Clears all their chapter assignments across every project in the org, then deletes all their role grants (anchor + project-scoped + org-scoped). Org Manager only. The user's account and grants in other orgs are unaffected.",
});

server.openapi(removeOrgUserRoute, async (c) => {
  const { orgId, userId } = c.req.valid('param');
  const caller = c.get('user')!;

  // Self-removal is blocked for the same reason self-role-change is (D2): an
  // Org Manager who could remove themselves could leave the org with no OM.
  if (caller.id === userId) {
    return c.json(
      { message: 'You cannot remove yourself from the organization.' },
      HttpStatusCodes.FORBIDDEN
    );
  }

  const result = await removeOrgUser(orgId, userId);
  if (result.ok) return c.body(null, HttpStatusCodes.NO_CONTENT);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── PATCH /organizations/:orgId/users/:userId ─────────────────────────────────

const updateOrgUserRoleRoute = createRoute({
  tags: ['Organizations - Users'],
  method: 'patch',
  path: '/organizations/{orgId}/users/{userId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.USER_UPDATE, (c) => {
      const orgId = Number(c.req.param('orgId'));
      return Number.isFinite(orgId) ? { orgId } : {};
    }),
  ] as const,
  request: {
    params: orgUserParamSchema,
    body: jsonContentRequired(
      updateOrgUserRoleBodySchema,
      'New org-level role: "Org Manager" to grant it, "Org Member" to remove the org-level role (demote).'
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userResponseSchema,
      'The updated user with refreshed role grants'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.BAD_REQUEST),
      'User is not a member of this org'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient privileges to assign this role, or self-role-change attempted'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Update org-level role for a user',
  description:
    'Changes the org-level role of an existing org member. Org-level roles only (D1): project roles remain project-scoped and are never touched. "Org Member" demotes — it deletes the org-level role row while keeping the membership anchor and all project-scoped grants. A caller may not change their own role (D2).',
});

server.openapi(updateOrgUserRoleRoute, async (c) => {
  const { orgId, userId } = c.req.valid('param');
  const { roleName } = c.req.valid('json');
  const caller = c.get('user')!;

  const policyUser = { id: caller.id, grants: caller.grants };
  if (!canAssignRole(policyUser, roleName, orgId, null)) {
    return c.json(
      { message: 'Forbidden: Insufficient privileges to assign this role.' },
      HttpStatusCodes.FORBIDDEN
    );
  }

  const roleId = await getRoleId(roleName);
  const result = await updateOrgUserRole(caller.id, orgId, userId, roleId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
