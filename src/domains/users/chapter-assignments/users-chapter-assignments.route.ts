import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { requireUserAccess } from '@/domains/users/user-auth.middleware';
import { USER_ACTIONS } from '@/domains/users/users.types';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission, requireSelf } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as service from '../../projects/chapter-assignments/project-chapter-assignments.service';
import * as usersChapterAssignmentsService from './users-chapter-assignments.service';
import {
  memberChapterAssignmentsResponseSchema,
  userChapterAssignmentsByUserResponseSchema,
} from './users-chapter-assignments.types';

const getChapterAssignmentsByUserIdRoute = createRoute({
  tags: ['Users - Chapter Assignments'],
  method: 'get',
  path: '/users/{userId}/chapter-assignments',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.USER_VIEW),
    requireUserAccess(USER_ACTIONS.VIEW, 'userId'),
  ] as const,
  request: {
    params: z.object({
      userId: z.coerce.number().int().positive(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userChapterAssignmentsByUserResponseSchema.openapi('ChapterAssignmentsByUser'),
      'Chapter assignments for the user separated by role'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Access denied'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'User not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get chapter assignments by user ID',
  description: 'Returns all chapter assignments for a user. Translators can only fetch their own.',
});

server.openapi(getChapterAssignmentsByUserIdRoute, async (c) => {
  const { userId } = c.req.valid('param');

  const result = await usersChapterAssignmentsService.getAllChapterAssignmentsByUserId(userId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

const getUserChapterAssignmentsRoute = createRoute({
  tags: ['Users - Chapter Assignments'],
  method: 'get',
  path: '/users/{userId}/chapter-assignments/all',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireSelf(),
  ] as const,
  summary: 'Get all chapter assignments for a user across all their projects',
  description:
    'Fetches all projects the user belongs to, then returns all chapter assignments ' +
    'across those projects in a single flat list — including unassigned ones.',
  request: {
    params: z.object({
      userId: z.coerce
        .number()
        .int()
        .positive()
        .openapi({
          param: { name: 'userId', in: 'path', required: true },
          example: 1,
        }),
    }),
    query: z.object({
      excludeProjectIds: z
        .string()
        .optional()
        .transform((val) => val?.split(',').map(Number).filter(Boolean) ?? [])
        .openapi({
          param: { name: 'excludeProjectIds', in: 'query', required: false },
          description: 'Comma-separated list of project IDs to exclude',
          example: '97,98',
        }),
      updatedAfter: z
        .string()
        .optional()
        .transform((val) => (val ? new Date(val) : undefined))
        .pipe(z.date().optional())
        .openapi({
          param: { name: 'updatedAfter', in: 'query', required: false },
          description: 'Return only assignments updated after this ISO timestamp',
          example: '2025-01-01T00:00:00.000Z',
        }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      memberChapterAssignmentsResponseSchema.openapi('UserChapterAssignments'),
      'Flat list of all chapter assignments across all user projects'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Access denied'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});
server.openapi(getUserChapterAssignmentsRoute, async (c) => {
  const { userId } = c.req.valid('param');
  const { excludeProjectIds, updatedAfter } = c.req.valid('query');

  const result = await service.getChapterAssignmentsByUserId(
    userId,
    excludeProjectIds,
    updatedAfter
  );
  if (result.ok)
    return c.json(
      {
        syncedAt: new Date().toISOString(),
        data: result.data,
      },
      HttpStatusCodes.OK
    );
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
