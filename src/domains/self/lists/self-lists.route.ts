import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import * as chapterAssignmentsByUserService from '@/domains/projects/chapter-assignments/project-chapter-assignments.service';
import * as userChapterAssignmentsService from '@/domains/users/chapter-assignments/users-chapter-assignments.service';
import {
  excludeProjectIdsQuerySchema,
  memberChapterAssignmentsResponseSchema,
  userChapterAssignmentsByUserResponseSchema,
} from '@/domains/users/chapter-assignments/users-chapter-assignments.types';
import * as userMilestonesService from '@/domains/users/milestones/user-milestones.service';
import { userMilestoneResponseSchema } from '@/domains/users/milestones/user-milestones.types';
import * as userProjectsService from '@/domains/users/projects/user-projects.service';
import { userProjectResponseSchema } from '@/domains/users/projects/user-projects.types';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

const unauthorized = jsonContent(
  createMessageObjectSchema('Unauthorized'),
  'Authentication required'
);
const inactiveAccount = jsonContent(
  createMessageObjectSchema(HttpStatusPhrases.FORBIDDEN),
  'User account is inactive'
);
const internalError = jsonContent(
  createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
  'Internal server error'
);

const getSelfProjectsRoute = createRoute({
  tags: ['Self'],
  method: 'get',
  path: '/self/projects',
  middleware: [authenticateUser] as const,
  request: {
    query: z.object({
      role: z
        .string()
        .optional()
        .openapi({
          param: { name: 'role', in: 'query', required: false },
          example: 'Project Observer',
          description:
            'Filter projects by the user\'s role name (e.g. "Project Observer", "Project Translator")',
        }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userProjectResponseSchema.array(),
      'Projects the current user is a member of. Empty when the user is in no project.'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorized,
    [HttpStatusCodes.FORBIDDEN]: inactiveAccount,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalError,
  },
  summary: 'Get projects for the current user',
  description:
    'Session-scoped list of projects for the authenticated user. Authenticates only; a caller in no project receives 200 [].',
});

server.openapi(getSelfProjectsRoute, async (c) => {
  const { role } = c.req.valid('query');
  const currentUser = c.get('user')!;
  const activeOrgId = c.get('activeOrgId');

  const result = await userProjectsService.getProjectsByUserId(
    currentUser.id,
    activeOrgId ?? undefined,
    role
  );
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

const getSelfMilestonesRoute = createRoute({
  tags: ['Self'],
  method: 'get',
  path: '/self/milestones',
  middleware: [authenticateUser] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userMilestoneResponseSchema.array(),
      'Milestones across projects the current user belongs to. Empty when the user is in no project.'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorized,
    [HttpStatusCodes.FORBIDDEN]: inactiveAccount,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalError,
  },
  summary: 'Get milestones for the current user',
  description:
    'Session-scoped flat list of milestones for the authenticated user. Authenticates only; a caller in no project receives 200 [].',
});

server.openapi(getSelfMilestonesRoute, async (c) => {
  const currentUser = c.get('user')!;
  const activeOrgId = c.get('activeOrgId');

  const result = await userMilestonesService.getMilestonesByUserId(
    currentUser.id,
    activeOrgId ?? undefined
  );
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

const getSelfChapterAssignmentsAllRoute = createRoute({
  tags: ['Self'],
  method: 'get',
  path: '/self/chapter-assignments/all',
  middleware: [authenticateUser] as const,
  request: {
    query: z.object({
      excludeProjectIds: excludeProjectIdsQuerySchema,
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
      memberChapterAssignmentsResponseSchema,
      "Flat list of chapter assignments across the current user's projects. data is [] when the user is in no project."
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorized,
    [HttpStatusCodes.FORBIDDEN]: inactiveAccount,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalError,
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
  tags: ['Self'],
  method: 'get',
  path: '/self/chapter-assignments',
  middleware: [authenticateUser] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      userChapterAssignmentsByUserResponseSchema,
      'Assigned and peer-check chapters for the current user. Both lists are empty when the user has none.'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorized,
    [HttpStatusCodes.FORBIDDEN]: inactiveAccount,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalError,
  },
  summary: 'Get chapter assignments for the current user',
  description:
    'Session-scoped assigned and peer-check chapters for the authenticated user. Authenticates only.',
});

server.openapi(getSelfChapterAssignmentsRoute, async (c) => {
  const currentUser = c.get('user')!;
  const activeOrgId = c.get('activeOrgId');

  const result = await userChapterAssignmentsService.getAllChapterAssignmentsByUserId(
    currentUser.id,
    activeOrgId ?? undefined
  );
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
