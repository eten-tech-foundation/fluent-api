import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as projectBooksService from './project-books.service';
import { projectBookSchema, projectIdParamSchema } from './project-books.types';

const getProjectBooksRoute = createRoute({
  tags: ['Projects - Bible Books'],
  method: 'get',
  path: '/projects/{projectId}/books',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  request: {
    params: projectIdParamSchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      projectBookSchema.array().openapi('ProjectBooks'),
      'The list of bible books associated with the project'
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
  summary: 'Get all bible books for a project',
  description: 'Returns a list of all bible books associated with a specific project',
});

server.openapi(getProjectBooksRoute, async (c) => {
  const { projectId } = c.req.valid('param');

  const result = await projectBooksService.getBooksByProjectId(projectId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
