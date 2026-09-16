import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as organizationsService from './organizations.service';
import {
  createOrganizationRequestSchema,
  organizationResponseSchema,
  organizationSummarySchema,
} from './organizations.types';

const orgIdParamSchema = z.object({
  orgId: z.coerce.number().openapi({
    param: { name: 'orgId', in: 'path', required: true },
    example: 1,
  }),
});

const validationErrorSchema = z.object({
  success: z.boolean(),
  error: z.object({
    issues: z.array(
      z.object({ code: z.string(), path: z.array(z.string()), message: z.string() })
    ),
    name: z.string(),
  }),
});

// ─── GET /organizations ───────────────────────────────────────────────────────

const listOrganizationsRoute = createRoute({
  tags: ['Organizations'],
  method: 'get',
  path: '/organizations',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.ORG_VIEW, () => ({})),
  ] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      organizationSummarySchema.array().openapi('Organizations'),
      'The list of organizations, ordered by name'
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
  summary: 'List organizations',
  description:
    'Returns all organizations ordered by name, each with a count of distinct Org Managers. SuperAdmin only.',
});

server.openapi(listOrganizationsRoute, async (c) => {
  const result = await organizationsService.listOrganizations();
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── POST /organizations ──────────────────────────────────────────────────────

const createOrganizationRoute = createRoute({
  tags: ['Organizations'],
  method: 'post',
  path: '/organizations',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.ORG_CREATE, () => ({})),
  ] as const,
  request: {
    body: jsonContent(createOrganizationRequestSchema, 'The organization to create'),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(
      organizationResponseSchema,
      'The created organization'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('Conflict'),
      'An organization with this name already exists'
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
      validationErrorSchema,
      'The validation error'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Create an organization',
  description:
    'Creates a new organization. Invite its first Org Manager afterwards via POST /users/invite. SuperAdmin only.',
});

server.openapi(createOrganizationRoute, async (c) => {
  const body = c.req.valid('json');

  const result = await organizationsService.createOrganization(body);
  if (result.ok) return c.json(result.data, HttpStatusCodes.CREATED);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /organizations/{orgId} ───────────────────────────────────────────────

const getOrganizationRoute = createRoute({
  tags: ['Organizations'],
  method: 'get',
  path: '/organizations/{orgId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.ORG_VIEW, () => ({})),
  ] as const,
  request: { params: orgIdParamSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(organizationSummarySchema, 'The organization'),
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
      'Insufficient permissions'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get an organization',
  description:
    'Returns a single organization with its Org Manager count. SuperAdmin only.',
});

server.openapi(getOrganizationRoute, async (c) => {
  const { orgId } = c.req.valid('param');

  const result = await organizationsService.getOrganization(orgId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
