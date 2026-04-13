import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { ProjectPolicy } from '@/domains/projects/project.policy';
import * as projectService from '@/domains/projects/projects.service';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as projectUsersService from './project-users.service';
import {
  addProjectUserSchema,
  projectIdParamSchema,
  projectUserResponseSchema,
  removeProjectUserParamSchema,
} from './project-users.types';

// ─── GET /projects/:projectId/users ──────────────────────────────────────────

const getProjectUsersRoute = createRoute({
  tags: ['Projects - Users'],
  method: 'get',
  path: '/projects/{projectId}/users',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.PROJECT_VIEW)] as const,
  request: { params: projectIdParamSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      projectUserResponseSchema.array().openapi('ProjectUsers'),
      'List of users in the project'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Project access required'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Project not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get project users',
  description: 'Returns all users assigned to a project',
});

server.openapi(getProjectUsersRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const currentUser = c.get('user')!;

  const projectResult = await projectService.getProjectById(projectId);
  if (!projectResult.ok) {
    return c.json(
      { message: projectResult.error.message },
      getHttpStatus(projectResult.error) as never
    );
  }

  const isProjectMember = await projectUsersService.resolveIsProjectMember(
    projectId,
    currentUser.id,
    currentUser.roleName
  );

  if (!ProjectPolicy.read(currentUser, projectResult.data, isProjectMember)) {
    return c.json({ message: 'Forbidden' }, HttpStatusCodes.FORBIDDEN);
  }

  const result = await projectUsersService.getProjectUsers(projectId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── POST /projects/:projectId/users ─────────────────────────────────────────

const addProjectUsersRoute = createRoute({
  tags: ['Projects - Users'],
  method: 'post',
  path: '/projects/{projectId}/users',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.PROJECT_UPDATE)] as const,
  request: {
    params: projectIdParamSchema,
    body: jsonContentRequired(addProjectUserSchema, 'Users to add to the project'),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(
      projectUserResponseSchema.array().openapi('ProjectUsersAdded'),
      'User(s) successfully added to project'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('Conflict'),
      'User already in project'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Project or one or more users not found'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Manager access required'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Bulk add users to project',
  description: 'Adds multiple users to the project in one request. Manager only.',
});

server.openapi(addProjectUsersRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const { userIds } = c.req.valid('json');
  const currentUser = c.get('user')!;

  const projectResult = await projectService.getProjectById(projectId);
  if (!projectResult.ok || !ProjectPolicy.update(currentUser, projectResult.data)) {
    return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
  }

  const result = await projectUsersService.addProjectUsers(projectId, userIds);
  if (result.ok) return c.json(result.data, HttpStatusCodes.CREATED);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── DELETE /projects/:projectId/users/:userId ────────────────────────────────

const removeProjectUserRoute = createRoute({
  tags: ['Projects - Users'],
  method: 'delete',
  path: '/projects/{projectId}/users/{userId}',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.PROJECT_UPDATE)] as const,
  request: {
    params: removeProjectUserParamSchema,
  },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: {
      description: 'User successfully removed from project',
    },
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'User still has content assigned'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Manager access required'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Project or User not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Remove user from project',
  description:
    'Removes a user from the project. Fails if the user still has assigned content. Manager only.',
});

server.openapi(removeProjectUserRoute, async (c) => {
  const { projectId, userId } = c.req.valid('param');
  const currentUser = c.get('user')!;

  const projectResult = await projectService.getProjectById(projectId);
  if (!projectResult.ok || !ProjectPolicy.update(currentUser, projectResult.data)) {
    return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
  }

  const result = await projectUsersService.removeProjectUser(projectId, userId);
  if (result.ok) return c.body(null, HttpStatusCodes.NO_CONTENT);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
