import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { logger } from '@/lib/logger';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireProjectAccess } from '../project-auth.middleware';
import { PROJECT_ACTIONS } from '../projects.types';
import * as service from './workflow-stages.service';
import {
  addWorkflowStageSchema,
  renameWorkflowStageSchema,
  reorderWorkflowStagesSchema,
  workflowStepResponseSchema,
} from './workflow-stages.types';

// ─── Shared param schemas ────────────────────────────────────────────────────

const projectIdParam = z.object({
  projectId: z.coerce
    .number()
    .openapi({ param: { name: 'projectId', in: 'path', required: true } }),
});

const projectAndStageIdParam = z.object({
  projectId: z.coerce
    .number()
    .openapi({ param: { name: 'projectId', in: 'path', required: true } }),
  stageId: z.coerce.number().openapi({ param: { name: 'stageId', in: 'path', required: true } }),
});

// ─── GET /projects/:projectId/workflow-stages ────────────────────────────────

const getWorkflowStagesRoute = createRoute({
  tags: ['Workflow Stages'],
  method: 'get',
  path: '/projects/{projectId}/workflow-stages',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'Get all workflow stages for a project',
  request: { params: projectIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(workflowStepResponseSchema), 'List of stages'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Auth required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Project not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(getWorkflowStagesRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const result = await service.getWorkflowStages(projectId);
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── POST /projects/:projectId/workflow-stages ───────────────────────────────

const addWorkflowStageRoute = createRoute({
  tags: ['Workflow Stages'],
  method: 'post',
  path: '/projects/{projectId}/workflow-stages',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Add a new workflow stage',
  request: {
    params: projectIdParam,
    body: jsonContentRequired(addWorkflowStageSchema, 'Stage details'),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(workflowStepResponseSchema, 'Created stage'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Validation error'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Project not found'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('Conflict'),
      'Stage limit reached or duplicate name'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(addWorkflowStageRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await service.addStage(projectId, body.displayName);
  if (!result.ok) {
    logger.error({ error: result.error }, 'Workflow add stage failed');
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.CREATED);
});

// ─── PATCH /projects/:projectId/workflow-stages/:stageId ────────────────────

const renameWorkflowStageRoute = createRoute({
  tags: ['Workflow Stages'],
  method: 'patch',
  path: '/projects/{projectId}/workflow-stages/{stageId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Rename a workflow stage',
  request: {
    params: projectAndStageIdParam,
    body: jsonContentRequired(renameWorkflowStageSchema, 'New name'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(workflowStepResponseSchema, 'Updated stage'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Validation error'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Stage not found'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('Conflict'),
      'Duplicate name'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(renameWorkflowStageRoute, async (c) => {
  const { projectId, stageId } = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await service.renameStage(projectId, stageId, body.displayName);
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── DELETE /projects/:projectId/workflow-stages/:stageId ───────────────────

const deleteWorkflowStageRoute = createRoute({
  tags: ['Workflow Stages'],
  method: 'delete',
  path: '/projects/{projectId}/workflow-stages/{stageId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Delete a workflow stage',
  request: { params: projectAndStageIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.array(workflowStepResponseSchema),
      'Updated list of stages'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Validation error'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Stage not found'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('Conflict'),
      'Stage is locked'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(deleteWorkflowStageRoute, async (c) => {
  const { projectId, stageId } = c.req.valid('param');
  const result = await service.deleteStage(projectId, stageId);
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── PUT /projects/:projectId/workflow-stages/reorder ───────────────────────

const reorderWorkflowStagesRoute = createRoute({
  tags: ['Workflow Stages'],
  method: 'put',
  path: '/projects/{projectId}/workflow-stages/reorder',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE, 'projectId'),
  ] as const,
  summary: 'Reorder workflow stages',
  request: {
    params: projectIdParam,
    body: jsonContentRequired(reorderWorkflowStagesSchema, 'Stage IDs in new order'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.array(workflowStepResponseSchema),
      'Updated list of stages'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Invalid stage list or cannot move fixed stage'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Project not found'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('Conflict'),
      'Stage is locked'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(reorderWorkflowStagesRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await service.reorderStages(projectId, body.stageIds);
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});
