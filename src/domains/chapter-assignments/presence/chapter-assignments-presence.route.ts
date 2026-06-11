import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { requireChapterAssignmentAccess } from '@/domains/chapter-assignments/chapter-assignment-auth.middleware';
import { CHAPTER_ASSIGNMENT_ACTIONS } from '@/domains/chapter-assignments/chapter-assignments.types';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as presenceService from './chapter-assignments-presence.service';
import { presenceResponseSchema } from './chapter-assignments-presence.types';

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

const registerPresenceRoute = createRoute({
  tags: ['Chapter Assignments - Presence'],
  method: 'post',
  path: '/chapter-assignments/{chapterAssignmentId}/presence',
  middleware: [
    authenticateUser,
    requireChapterAssignmentAccess(CHAPTER_ASSIGNMENT_ACTIONS.IS_PARTICIPANT),
  ] as const,
  request: { params: chapterAssignmentIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(presenceResponseSchema, 'Presence registered successfully'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
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
  summary: 'Send heartbeat and check for concurrent editors',
  description:
    'Registers the current user as active on this chapter and returns concurrent-editor info.',
});

const removePresenceRoute = createRoute({
  tags: ['Chapter Assignments - Presence'],
  method: 'delete',
  path: '/chapter-assignments/{chapterAssignmentId}/presence',
  middleware: [
    authenticateUser,
    requireChapterAssignmentAccess(CHAPTER_ASSIGNMENT_ACTIONS.IS_PARTICIPANT),
  ] as const,
  request: { params: chapterAssignmentIdParam },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: { description: 'Presence removed successfully' },
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
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
  summary: 'Remove user from active editors',
  description: 'Removes the current user from the list of active editors for this chapter.',
});

server.openapi(registerPresenceRoute, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');
  const currentUser = c.get('user')!;

  const result = await presenceService.registerPresenceAndCheck(
    currentUser.id,
    chapterAssignmentId
  );
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

server.openapi(removePresenceRoute, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');
  const currentUser = c.get('user')!;

  const result = await presenceService.removePresence(currentUser.id, chapterAssignmentId);
  if (result.ok) return c.body(null, HttpStatusCodes.NO_CONTENT);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
