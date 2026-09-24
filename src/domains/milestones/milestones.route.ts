import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
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

// ─── POST /projects/:projectId/milestones ──────────────────────────────────────

const createMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'post',
  path: '/projects/{projectId}/milestones',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Create a milestone for a project',
  request: {
    params: projectIdParamSchema,
    body: jsonContentRequired(createMilestoneSchema, 'Milestone to create'),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(milestoneResponseSchema, 'Created milestone'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.BAD_REQUEST),
      'Constraint violation'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(createMilestoneRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const input = c.req.valid('json');

  const project = c.get('project')!;
  const sourceBibleId = project.sourceBibleId;
  if (!sourceBibleId) {
    return c.json({ message: 'Project has no source Bible' }, HttpStatusCodes.BAD_REQUEST);
  }

  const result = await milestonesService.createMilestone(projectId, sourceBibleId, input);
  if (result.ok) return c.json(result.data as any, HttpStatusCodes.CREATED);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /projects/:projectId/milestones ───────────────────────────────────────

const listMilestonesRoute = createRoute({
  tags: ['Milestones'],
  method: 'get',
  path: '/projects/{projectId}/milestones',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'List milestones for a project',
  request: { params: projectIdParamSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(milestoneResponseSchema), 'List of milestones'),
  },
});

server.openapi(listMilestonesRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const result = await milestonesService.listMilestonesForProject(projectId);
  if (result.ok) return c.json(result.data as any, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /projects/:projectId/milestones/:milestoneId ──────────────────────────

const getMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'get',
  path: '/projects/{projectId}/milestones/{milestoneId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'Get a milestone',
  request: { params: milestonePathParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(milestoneResponseSchema, 'Milestone'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Milestone not found'
    ),
  },
});

server.openapi(getMilestoneRoute, async (c) => {
  const { projectId, milestoneId } = c.req.valid('param');
  const result = await milestonesService.getMilestone(projectId, milestoneId);
  if (result.ok) return c.json(result.data as any, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── PATCH /projects/:projectId/milestones/:milestoneId ────────────────────────

const updateMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'patch',
  path: '/projects/{projectId}/milestones/{milestoneId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Update a milestone',
  request: {
    params: milestonePathParamsSchema,
    body: jsonContentRequired(updateMilestoneSchema, 'Updates'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(milestoneResponseSchema, 'Updated milestone'),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.UNPROCESSABLE_ENTITY),
      'Empty update body'
    ),
  },
});

server.openapi(updateMilestoneRoute, async (c) => {
  const { projectId, milestoneId } = c.req.valid('param');
  const updates = c.req.valid('json');
  const project = c.get('project')!;

  if (Object.keys(updates).length === 0) {
    return c.json({ message: 'Empty update body' }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }

  const result = await milestonesService.updateMilestone(
    projectId,
    milestoneId,
    updates,
    project.sourceBibleId
  );
  if (result.ok) return c.json(result.data as any, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── DELETE /projects/:projectId/milestones/:milestoneId ───────────────────────

const deleteMilestoneRoute = createRoute({
  tags: ['Milestones'],
  method: 'delete',
  path: '/projects/{projectId}/milestones/{milestoneId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Delete a milestone',
  request: { params: milestonePathParamsSchema },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: { description: 'Deleted' },
  },
});

server.openapi(deleteMilestoneRoute, async (c) => {
  const { projectId, milestoneId } = c.req.valid('param');
  const result = await milestonesService.deleteMilestone(projectId, milestoneId);
  if (result.ok) return c.body(null, HttpStatusCodes.NO_CONTENT);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
