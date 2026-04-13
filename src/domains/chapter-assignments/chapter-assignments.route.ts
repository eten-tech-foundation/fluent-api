import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import * as projectHandler from '@/domains/projects/projects.service';
import { PERMISSIONS } from '@/lib/permissions';
import { ErrorCode, getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireChapterAssignmentAccess } from './chapter-assignment-auth.middleware';
import { ChapterAssignmentPolicy } from './chapter-assignments.policy';
import * as chapterAssignmentService from './chapter-assignments.service';
import {
  CHAPTER_ASSIGNMENT_ACTIONS,
  chapterAssignmentResponseSchema,
} from './chapter-assignments.types';

const chapterAssignmentIdParam = z.object({
  chapterAssignmentId: z.coerce.number().int().positive(),
});

// ─── POST /chapter-assignments ────────────────────────────────────────────────

const createChapterAssignmentRoute = createRoute({
  tags: ['Chapter Assignments'],
  method: 'post',
  path: '/chapter-assignments',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_ASSIGN)] as const,
  request: {
    body: jsonContent(
      z.object({
        projectUnitId: z.number().int(),
        bibleId: z.number().int(),
        bookId: z.number().int(),
        chapterNumber: z.number().int(),
        assignedUserId: z.number().int().optional(),
        peerCheckerId: z.number().int().optional(),
      }),
      'Chapter assignment data'
    ),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(
      chapterAssignmentResponseSchema,
      'The created chapter assignment'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Validation error'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Permission denied'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Project unit or project not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Create a new chapter assignment',
  description: 'Creates a new chapter assignment.',
});

server.openapi(createChapterAssignmentRoute, async (c) => {
  const requestData = c.req.valid('json');
  const user = c.get('user')!;
  const policyUser = { id: user.id, roleName: user.roleName, organization: user.organization };

  const unitResult = await projectHandler.getProjectIdByUnitId(requestData.projectUnitId);
  if (!unitResult.ok) {
    return c.json({ message: 'Project unit not found' }, HttpStatusCodes.NOT_FOUND);
  }

  const projectResult = await projectHandler.getProjectById(unitResult.data.projectId);
  if (!projectResult.ok) {
    return c.json({ message: 'Project not found' }, HttpStatusCodes.NOT_FOUND);
  }

  if (!ChapterAssignmentPolicy.create(policyUser, projectResult.data.organization)) {
    return c.json(
      { message: 'Forbidden: You do not have permission to create assignments.' },
      HttpStatusCodes.FORBIDDEN
    );
  }

  const result = await chapterAssignmentService.createChapterAssignment(requestData);
  if (result.ok) return c.json(result.data, HttpStatusCodes.CREATED);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── PATCH /chapter-assignments/:chapterAssignmentId ─────────────────────────

const updateChapterAssignmentRoute = createRoute({
  tags: ['Chapter Assignments'],
  method: 'patch',
  path: '/chapter-assignments/{chapterAssignmentId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_ASSIGN),
    requireChapterAssignmentAccess(CHAPTER_ASSIGNMENT_ACTIONS.UPDATE),
  ] as const,
  request: {
    params: chapterAssignmentIdParam,
    body: jsonContent(
      z.object({
        assignedUserId: z.number().int(),
        peerCheckerId: z.number().int(),
      }),
      'Users to assign to the chapter assignment.'
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      chapterAssignmentResponseSchema,
      'The updated chapter assignment'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Validation error'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Permission denied'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Chapter assignment not found'
    ),
  },
  summary: 'Update a chapter assignment',
  description: 'Updates a chapter assignment.',
});

server.openapi(updateChapterAssignmentRoute, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');
  const requestData = c.req.valid('json');

  const result = await chapterAssignmentService.updateChapterAssignment(
    chapterAssignmentId,
    requestData
  );
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── PATCH /chapter-assignments/:chapterAssignmentId/submit ──────────────────

const submitChapterAssignmentRoute = createRoute({
  tags: ['Chapter Assignments'],
  method: 'patch',
  path: '/chapter-assignments/{chapterAssignmentId}/submit',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_UPDATE),
    requireChapterAssignmentAccess(CHAPTER_ASSIGNMENT_ACTIONS.SUBMIT),
  ] as const,
  request: { params: chapterAssignmentIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      chapterAssignmentResponseSchema,
      'The submitted chapter assignment'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Invalid status transition'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Permission denied'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Chapter assignment not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Submit a chapter assignment',
  description:
    'Advances chapter assignment to next stage: draft → peer_check → community_review → linguist_check → theological_check → consultant_check → complete.',
});

server.openapi(submitChapterAssignmentRoute, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');

  const result = await chapterAssignmentService.submitChapterAssignment(chapterAssignmentId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);

  if (result.error.code === ErrorCode.INVALID_STATUS_TRANSITION) {
    return c.json({ message: result.error.message }, HttpStatusCodes.BAD_REQUEST);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /chapter-assignments/:chapterAssignmentId ────────────────────────────

const getChapterAssignmentRoute = createRoute({
  tags: ['Chapter Assignments'],
  method: 'get',
  path: '/chapter-assignments/{chapterAssignmentId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireChapterAssignmentAccess(CHAPTER_ASSIGNMENT_ACTIONS.READ),
  ] as const,
  request: { params: chapterAssignmentIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(chapterAssignmentResponseSchema, 'The chapter assignment'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Permission denied'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Chapter assignment not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get a chapter assignment',
  description: 'Get a chapter assignment.',
});

server.openapi(getChapterAssignmentRoute, async (c) => {
  const assignment = c.get('chapterAssignment')!;
  return c.json(
    chapterAssignmentService.toChapterAssignmentResponse(assignment),
    HttpStatusCodes.OK
  );
});

// ─── DELETE /chapter-assignments/:chapterAssignmentId ────────────────────────

const deleteChapterAssignmentRoute = createRoute({
  tags: ['Chapter Assignments'],
  method: 'delete',
  path: '/chapter-assignments/{chapterAssignmentId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_ASSIGN),
    requireChapterAssignmentAccess(CHAPTER_ASSIGNMENT_ACTIONS.DELETE),
  ] as const,
  request: { params: chapterAssignmentIdParam },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: { description: 'Chapter assignment deleted' },
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Permission denied'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Chapter assignment not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Delete a chapter assignment',
  description: 'Delete a chapter assignment.',
});

server.openapi(deleteChapterAssignmentRoute, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');

  const result = await chapterAssignmentService.deleteChapterAssignment(chapterAssignmentId);
  if (result.ok) return c.body(null, HttpStatusCodes.NO_CONTENT);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
