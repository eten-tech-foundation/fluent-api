import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { ZOD_ERROR_MESSAGES } from '@/lib/constants';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as milestonesService from './milestones.service';
import {
  createMilestoneSchema,
  milestonePathParamsSchema,
  milestoneResponseSchema,
  projectIdParamSchema,
  updateMilestoneSchema,
} from './milestones.types';

const notFound = jsonContent(
  createMessageObjectSchema('Not found'),
  'Project or milestone not found'
);
const unauthorized = jsonContent(
  createMessageObjectSchema('Unauthorized'),
  'Authentication required'
);
const forbidden = jsonContent(createMessageObjectSchema('Forbidden'), 'Project access required');
const serverError = jsonContent(
  createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
  'Internal server error'
);

// ─── GET /projects/{projectId}/milestones ─────────────────────────────────────

const listMilestonesRoute = createRoute({
  tags: ['Milestones'],
  method: 'get',
  path: '/projects/{projectId}/milestones',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  request: { params: projectIdParamSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      milestoneResponseSchema.array(),
      'Milestones for the project'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorized,
    [HttpStatusCodes.FORBIDDEN]: forbidden,
    [HttpStatusCodes.NOT_FOUND]: notFound,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: serverError,
  },
  summary: 'List project milestones',
});

server.openapi(listMilestonesRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const result = await milestonesService.listMilestonesForProject(projectId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── POST /projects/{projectId}/milestones ────────────────────────────────────

const createMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'post',
  path: '/projects/{projectId}/milestones',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  request: {
    params: projectIdParamSchema,
    body: jsonContentRequired(createMilestoneSchema, 'Milestone to create'),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(milestoneResponseSchema, 'Created milestone'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.BAD_REQUEST),
      'Invalid books for the project Bible'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorized,
    [HttpStatusCodes.FORBIDDEN]: forbidden,
    [HttpStatusCodes.NOT_FOUND]: notFound,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: serverError,
  },
  summary: 'Create a milestone',
});

server.openapi(createMilestoneRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const body = c.req.valid('json');
  const project = c.get('project')!;

  const result = await milestonesService.createMilestone(projectId, project.sourceBibleId, body);
  if (result.ok) return c.json(result.data, HttpStatusCodes.CREATED);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /projects/{projectId}/milestones/{milestoneId} ───────────────────────

const getMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'get',
  path: '/projects/{projectId}/milestones/{milestoneId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  request: { params: milestonePathParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(milestoneResponseSchema, 'The milestone'),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorized,
    [HttpStatusCodes.FORBIDDEN]: forbidden,
    [HttpStatusCodes.NOT_FOUND]: notFound,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: serverError,
  },
  summary: 'Get a milestone',
});

server.openapi(getMilestoneRoute, async (c) => {
  const { projectId, milestoneId } = c.req.valid('param');
  const result = await milestonesService.getMilestone(projectId, milestoneId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── PATCH /projects/{projectId}/milestones/{milestoneId} ─────────────────────

const updateMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'patch',
  path: '/projects/{projectId}/milestones/{milestoneId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  request: {
    params: milestonePathParamsSchema,
    body: jsonContentRequired(updateMilestoneSchema, 'Milestone updates'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(milestoneResponseSchema, 'Updated milestone'),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorized,
    [HttpStatusCodes.FORBIDDEN]: forbidden,
    [HttpStatusCodes.NOT_FOUND]: notFound,
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema('Unprocessable Entity'),
      'No updates provided'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: serverError,
  },
  summary: 'Update a milestone',
});

server.openapi(updateMilestoneRoute, async (c) => {
  const { projectId, milestoneId } = c.req.valid('param');
  const updates = c.req.valid('json');

  if (Object.keys(updates).length === 0) {
    return c.json({ message: ZOD_ERROR_MESSAGES.NO_UPDATES }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }

  const result = await milestonesService.updateMilestone(projectId, milestoneId, updates);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── DELETE /projects/{projectId}/milestones/{milestoneId} ────────────────────

const deleteMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'delete',
  path: '/projects/{projectId}/milestones/{milestoneId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_DELETE),
    requireProjectAccess(PROJECT_ACTIONS.DELETE, 'projectId'),
  ] as const,
  request: { params: milestonePathParamsSchema },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: { description: 'Milestone deleted' },
    [HttpStatusCodes.UNAUTHORIZED]: unauthorized,
    [HttpStatusCodes.FORBIDDEN]: forbidden,
    [HttpStatusCodes.NOT_FOUND]: notFound,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: serverError,
  },
  summary: 'Delete a milestone',
});

server.openapi(deleteMilestoneRoute, async (c) => {
  const { projectId, milestoneId } = c.req.valid('param');
  const result = await milestonesService.deleteMilestone(projectId, milestoneId);
  if (result.ok) return c.body(null, HttpStatusCodes.NO_CONTENT);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
