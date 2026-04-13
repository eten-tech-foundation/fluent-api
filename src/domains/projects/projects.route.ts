import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { ZOD_ERROR_MESSAGES } from '@/lib/constants';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireProjectAccess } from './project-auth.middleware';
import * as projectService from './projects.service';
import {
  createProjectWithUnitsSchema,
  PROJECT_ACTIONS,
  projectResponseSchema,
  projectWithLanguageNamesSchema,
  updateProjectWithUnitsSchema,
} from './projects.types';

const idParam = z.object({
  id: z.coerce.number().openapi({ param: { name: 'id', in: 'path', required: true } }),
});

// ─── GET /projects ────────────────────────────────────────────────────────────

const listProjectsRoute = createRoute({
  tags: ['Projects'],
  method: 'get',
  path: '/projects',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.LIST),
  ] as const,
  summary: 'Get all projects',
  description: 'Project Managers: all projects in their organisation.',
  responses: {
    [HttpStatusCodes.OK]: jsonContent(projectWithLanguageNamesSchema.array(), 'List of projects'),
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
});

server.openapi(listProjectsRoute, async (c) => {
  const currentUser = c.get('user')!;

  const result = await projectService.getProjectsByOrganization(currentUser.organization);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── POST /projects ───────────────────────────────────────────────────────────

const createProjectRoute = createRoute({
  tags: ['Projects'],
  method: 'post',
  path: '/projects',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.PROJECT_CREATE)] as const,
  summary: 'Create a new project',
  description: 'Project Manager only.',
  request: { body: jsonContentRequired(createProjectWithUnitsSchema, 'Project to create') },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(projectResponseSchema, 'Created project'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.BAD_REQUEST),
      'Constraint violation'
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
});

server.openapi(createProjectRoute, async (c) => {
  const projectData = c.req.valid('json');
  const currentUser = c.get('user')!;

  const result = await projectService.createProject({
    ...projectData,
    createdBy: currentUser.id,
    organization: currentUser.organization,
  });

  if (result.ok) return c.json(result.data, HttpStatusCodes.CREATED);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /projects/:id ────────────────────────────────────────────────────────

const getProjectRoute = createRoute({
  tags: ['Projects'],
  method: 'get',
  path: '/projects/{id}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ),
  ] as const,
  summary: 'Get a project by ID',
  request: { params: idParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(projectWithLanguageNamesSchema, 'The project'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
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

server.openapi(getProjectRoute, async (c) => {
  const project = c.get('project')!;
  return c.json(project, HttpStatusCodes.OK);
});

// ─── PATCH /projects/:id ──────────────────────────────────────────────────────

const updateProjectRoute = createRoute({
  tags: ['Projects'],
  method: 'patch',
  path: '/projects/{id}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_UPDATE),
    requireProjectAccess(PROJECT_ACTIONS.UPDATE),
  ] as const,
  summary: 'Update a project',
  description: 'Project Manager only.',
  request: {
    params: idParam,
    body: jsonContentRequired(updateProjectWithUnitsSchema, 'Project updates'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(projectResponseSchema, 'Updated project'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.BAD_REQUEST),
      'Constraint violation'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Project not found'
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema('Unprocessable Entity'),
      'No updates provided'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(updateProjectRoute, async (c) => {
  const { id } = c.req.valid('param');
  const updates = c.req.valid('json');

  if (Object.keys(updates).length === 0) {
    return c.json({ message: ZOD_ERROR_MESSAGES.NO_UPDATES }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
  }

  const result = await projectService.updateProject(id, updates);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── DELETE /projects/:id ─────────────────────────────────────────────────────

const deleteProjectRoute = createRoute({
  tags: ['Projects'],
  method: 'delete',
  path: '/projects/{id}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_DELETE),
    requireProjectAccess(PROJECT_ACTIONS.DELETE),
  ] as const,
  summary: 'Delete a project',
  description: 'Project Manager only.',
  request: { params: idParam },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: { description: 'Project deleted' },
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
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

server.openapi(deleteProjectRoute, async (c) => {
  const { id } = c.req.valid('param');

  const result = await projectService.deleteProject(id);
  if (result.ok) return c.body(null, HttpStatusCodes.NO_CONTENT);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
