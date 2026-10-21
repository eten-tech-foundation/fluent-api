import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';

import * as chapterAssignmentsByUserService from '@/domains/projects/chapter-assignments/project-chapter-assignments.service';
import {
  inactiveAccountResponse,
  internalErrorResponse,
  unauthorizedResponse,
} from '@/domains/self/self-responses';
import {
  excludeProjectIdsQuerySchema,
  memberChapterAssignmentsResponseSchema,
  updatedAfterQuerySchema,
  userChapterAssignmentsByUserResponseSchema,
} from '@/domains/users/chapter-assignments/users-chapter-assignments.types';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as selfChapterAssignmentsService from './self-chapter-assignments.service';

const getSelfChapterAssignmentsAllRoute = createRoute({
  tags: ['Self - Chapter Assignments'],
  method: 'get',
  path: '/self/chapter-assignments/all',
  middleware: [authenticateUser] as const,
  request: {
    query: z.object({
      excludeProjectIds: excludeProjectIdsQuerySchema,
      updatedAfter: updatedAfterQuerySchema,
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      memberChapterAssignmentsResponseSchema,
      "Flat list of chapter assignments across the current user's projects. data is [] when the user is in no project."
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: inactiveAccountResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
  summary: 'Get all chapter assignments for the current user',
  description:
    "Session-scoped list of chapter assignments across the authenticated user's projects, including unassigned ones. Authenticates only.",
});

server.openapi(getSelfChapterAssignmentsAllRoute, async (c) => {
  const { excludeProjectIds, updatedAfter } = c.req.valid('query');
  const currentUser = c.get('user')!;
  const activeOrgId = c.get('activeOrgId');

  const result = await chapterAssignmentsByUserService.getChapterAssignmentsByUserId(
    currentUser.id,
    excludeProjectIds,
    updatedAfter,
    activeOrgId ?? undefined
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

const getSelfChapterAssignmentsRoute = createRoute({
  tags: ['Self - Chapter Assignments'],
  method: 'get',
  path: '/self/chapter-assignments',
  middleware: [authenticateUser] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userChapterAssignmentsByUserResponseSchema,
      'Assigned and peer-check chapters for the current user. Both lists are empty when the user is in no project.'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: inactiveAccountResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
  summary: 'Get chapter assignments for the current user',
  description:
    'Session-scoped assigned and peer-check chapters for the authenticated user, limited to projects they still belong to. Authenticates only.',
});

server.openapi(getSelfChapterAssignmentsRoute, async (c) => {
  const currentUser = c.get('user')!;
  const activeOrgId = c.get('activeOrgId');

  const result = await selfChapterAssignmentsService.getChapterAssignmentsForCurrentProjects(
    currentUser.id,
    activeOrgId ?? undefined
  );
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
