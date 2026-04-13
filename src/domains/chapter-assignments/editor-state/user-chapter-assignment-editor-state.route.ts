import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { insertUserChapterAssignmentEditorStateSchema } from '@/db/schema';
import { requireChapterAssignmentAccess } from '@/domains/chapter-assignments/chapter-assignment-auth.middleware';
import { CHAPTER_ASSIGNMENT_ACTIONS } from '@/domains/chapter-assignments/chapter-assignments.types';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as editorStateService from './user-chapter-assignment-editor-state.service';
import { editorStateResponseSchema } from './user-chapter-assignment-editor-state.types';

const chapterAssignmentIdParam = z.object({
  chapterAssignmentId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'chapterAssignmentId', in: 'path', required: true },
      description: 'Chapter assignment ID',
      example: 1,
    }),
});

// ─── GET /chapter-assignments/:chapterAssignmentId/editor-state ───────────────

const getEditorStateRoute = createRoute({
  tags: ['Chapter Assignments - Editor State'],
  method: 'get',
  path: '/chapter-assignments/{chapterAssignmentId}/editor-state',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_UPDATE),
    requireChapterAssignmentAccess(CHAPTER_ASSIGNMENT_ACTIONS.IS_PARTICIPANT),
  ] as const,
  request: { params: chapterAssignmentIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      editorStateResponseSchema,
      'The editor state for the current user'
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
      'Chapter assignment not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get editor state for current user',
  description:
    'Returns the saved editor state for the current user and specified chapter assignment.',
});

server.openapi(getEditorStateRoute, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');
  const currentUser = c.get('user')!;

  const result = await editorStateService.getEditorState(currentUser.id, chapterAssignmentId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, HttpStatusCodes.INTERNAL_SERVER_ERROR);
});

// ─── PUT /chapter-assignments/:chapterAssignmentId/editor-state ───────────────

const saveEditorStateRoute = createRoute({
  tags: ['Chapter Assignments - Editor State'],
  method: 'put',
  path: '/chapter-assignments/{chapterAssignmentId}/editor-state',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_UPDATE),
    requireChapterAssignmentAccess(CHAPTER_ASSIGNMENT_ACTIONS.IS_PARTICIPANT),
  ] as const,
  request: {
    params: chapterAssignmentIdParam,
    body: jsonContent(
      insertUserChapterAssignmentEditorStateSchema
        .omit({ userId: true, chapterAssignmentId: true })
        .openapi('EditorStateInput'),
      'The editor state to save'
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(editorStateResponseSchema, 'The saved editor state'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Invalid request data'
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
      'Chapter assignment not found'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Save editor state for current user',
  description: 'Saves or updates the editor state for the current user and chapter assignment.',
});

server.openapi(saveEditorStateRoute, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');
  const editorStateData = c.req.valid('json');
  const currentUser = c.get('user')!;

  const result = await editorStateService.upsertEditorState({
    userId: currentUser.id,
    chapterAssignmentId,
    ...editorStateData,
  });

  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
