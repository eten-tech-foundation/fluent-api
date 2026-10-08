import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { PERMISSIONS } from '../../../lib/permissions';
import { authenticateUser, requirePermission } from '../../../middlewares/role-auth';
import { server } from '../../../server/server';
import { requireProjectAccess } from './../project-auth.middleware';
import { PROJECT_ACTIONS } from './../projects.types';
import * as service from './workflow-stages.service';
import {
  addWorkflowStageSchema,
  renameWorkflowStageSchema,
  reorderWorkflowStagesSchema,
  workflowStepResponseSchema,
} from './workflow-stages.types';

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
  },
});

server.openapi(getWorkflowStagesRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  try {
    const stages = await service.getWorkflowStages(projectId);
    return c.json(stages, HttpStatusCodes.OK);
  } catch (error: any) {
    return c.json({ message: error.message }, HttpStatusCodes.INTERNAL_SERVER_ERROR as never);
  }
});

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
  },
});

server.openapi(addWorkflowStageRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const body = c.req.valid('json');
  try {
    const newStage = await service.addStage(projectId, body.displayName);
    return c.json(newStage, HttpStatusCodes.CREATED);
  } catch (error: any) {
    return c.json({ message: error.message }, HttpStatusCodes.BAD_REQUEST as never);
  }
});

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
  },
});

server.openapi(renameWorkflowStageRoute, async (c) => {
  const { projectId, stageId } = c.req.valid('param');
  const body = c.req.valid('json');
  try {
    const updatedStage = await service.renameStage(projectId, stageId, body.displayName);
    return c.json(updatedStage, HttpStatusCodes.OK);
  } catch (error: any) {
    return c.json({ message: error.message }, HttpStatusCodes.BAD_REQUEST as never);
  }
});

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
  },
});

server.openapi(deleteWorkflowStageRoute, async (c) => {
  const { projectId, stageId } = c.req.valid('param');
  try {
    const stages = await service.deleteStage(projectId, stageId);
    return c.json(stages, HttpStatusCodes.OK);
  } catch (error: any) {
    return c.json({ message: error.message }, HttpStatusCodes.BAD_REQUEST as never);
  }
});

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
      'Validation error'
    ),
  },
});

server.openapi(reorderWorkflowStagesRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const body = c.req.valid('json');
  try {
    const stages = await service.reorderStages(projectId, body.stageIds);
    return c.json(stages, HttpStatusCodes.OK);
  } catch (error: any) {
    return c.json({ message: error.message }, HttpStatusCodes.BAD_REQUEST as never);
  }
});
