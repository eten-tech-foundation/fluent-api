import { createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { Buffer } from 'node:buffer';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import type { ScopeResolver } from '@/middlewares/role-auth';

import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import type { CommentAnchorInput } from './draft-comments.types';

import * as draftCommentsService from './draft-comments.service';
import {
  ALLOWED_COMMENT_AUDIO_CONTENT_TYPES,
  chapterCommentAggregateSchema,
  chapterCommentResponseSchema,
  commentAnchorInputSchema,
  createReplyRequestSchema,
  createTopLevelCommentRequestSchema,
  listChapterCommentsResponseSchema,
  MAX_COMMENT_AUDIO_BYTES,
  setReactionRequestSchema,
} from './draft-comments.types';

const assignmentParams = z.object({
  chapterAssignmentId: z.coerce.number().int().positive(),
});

const commentParams = assignmentParams.extend({
  commentId: z.coerce.number().int().positive(),
});

const errorMessage = createMessageObjectSchema('Error');

/** FA-R4: unknown/inaccessible assignment is 404 (not empty-scope 403). */
const scopeFromChapterAssignment: ScopeResolver = async (c) => {
  const chapterAssignmentId = Number(c.req.param('chapterAssignmentId'));
  if (!Number.isFinite(chapterAssignmentId)) {
    throw new HTTPException(HttpStatusCodes.NOT_FOUND, {
      message: 'Chapter assignment not found',
    });
  }
  const ctx = await draftCommentsService.resolveCommentAssignmentScope(chapterAssignmentId);
  if (!ctx) {
    throw new HTTPException(HttpStatusCodes.NOT_FOUND, {
      message: 'Chapter assignment not found',
    });
  }
  return ctx;
};

const listRoute = createRoute({
  method: 'get',
  path: '/chapter-assignments/{chapterAssignmentId}/comments',
  tags: ['Draft comments'],
  summary: 'List chapter comments (connected + all retained Unconnected)',
  description:
    'Oldest→newest. Unconnected are sticky retained snapshots. Auth: project-scoped content:view.',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_VIEW, scopeFromChapterAssignment),
  ] as const,
  request: { params: assignmentParams },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(listChapterCommentsResponseSchema, 'Comments'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(errorMessage, 'Unauthorized'),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(errorMessage, 'Forbidden'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(errorMessage, 'Not found'),
  },
});

server.openapi(listRoute, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');
  const user = c.get('user')!;
  const result = await draftCommentsService.listChapterComments(
    { id: user.id, grants: user.grants },
    chapterAssignmentId
  );
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});

const aggregateRoute = createRoute({
  method: 'get',
  path: '/chapter-assignments/{chapterAssignmentId}/comment-aggregate',
  tags: ['Draft comments'],
  summary: 'Chapter commentCount + currentUserHasCommented (#703)',
  description:
    'commentCount = retained roots+replies+Unconnected (excludes reactions). currentUserHasCommented uses the authenticated viewer.',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_VIEW, scopeFromChapterAssignment),
  ] as const,
  request: { params: assignmentParams },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(chapterCommentAggregateSchema, 'Aggregate'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(errorMessage, 'Unauthorized'),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(errorMessage, 'Forbidden'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(errorMessage, 'Not found'),
  },
});

server.openapi(aggregateRoute, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');
  const user = c.get('user')!;
  const result = await draftCommentsService.getChapterCommentAggregate(
    { id: user.id, grants: user.grants },
    chapterAssignmentId
  );
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});

const createRouteDef = createRoute({
  method: 'post',
  path: '/chapter-assignments/{chapterAssignmentId}/comments',
  tags: ['Draft comments'],
  summary: 'Create top-level text or emoji-only comment',
  description:
    'Author is the authenticated session user. Requires project-scoped comment:write. Audio uses multipart on /comments/audio.',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.COMMENT_WRITE, scopeFromChapterAssignment),
  ] as const,
  request: {
    params: assignmentParams,
    body: jsonContentRequired(createTopLevelCommentRequestSchema, 'Comment'),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(chapterCommentResponseSchema, 'Created'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(errorMessage, 'Unauthorized'),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(errorMessage, 'Forbidden'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(errorMessage, 'Not found'),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(errorMessage, 'Validation'),
  },
});

server.openapi(createRouteDef, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user')!;
  const result = await draftCommentsService.createTopLevelComment(
    { id: user.id, grants: user.grants },
    chapterAssignmentId,
    body
  );
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.CREATED);
});

const createAudioRoute = createRoute({
  method: 'post',
  path: '/chapter-assignments/{chapterAssignmentId}/comments/audio',
  tags: ['Draft comments'],
  summary: 'Create audio comment or one-level audio reply (comment-owned storage; not verse-audio)',
  description:
    'multipart fields: file (required), optional replyToCommentId (flattens to root; inherits root anchor/connectionState; caller anchor ignored), else required anchorKind + bibleTextId|pericopeNumber, optional durationSeconds. Max 30MB; MIME allow-list. Never uses PUT /verse-audio.',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.COMMENT_WRITE, scopeFromChapterAssignment),
    bodyLimit({
      // Multipart boundaries, part headers, and text fields add overhead beyond file bytes.
      // Service still enforces MAX_COMMENT_AUDIO_BYTES on the file payload itself.
      maxSize: MAX_COMMENT_AUDIO_BYTES + 64 * 1024,
      onError: (c) =>
        c.json(
          { message: 'Request body exceeds the audio upload limit' },
          HttpStatusCodes.REQUEST_TOO_LONG
        ),
    }),
  ] as const,
  request: {
    params: assignmentParams,
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.any(),
            replyToCommentId: z.string().optional(),
            anchorKind: z.enum(['verse', 'pericope']).optional(),
            bibleTextId: z.string().optional(),
            pericopeNumber: z.string().optional(),
            durationSeconds: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(chapterCommentResponseSchema, 'Created'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(errorMessage, 'Unauthorized'),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(errorMessage, 'Forbidden'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(errorMessage, 'Not found'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(errorMessage, 'Validation'),
    [HttpStatusCodes.REQUEST_TOO_LONG]: jsonContent(errorMessage, 'Payload too large'),
    [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(errorMessage, 'Storage unavailable'),
  },
});

server.openapi(createAudioRoute, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');
  const user = c.get('user')!;
  const form = await c.req.parseBody({ all: true });
  const file = form.file;
  if (!(file instanceof File)) {
    return c.json({ message: 'file is required' }, HttpStatusCodes.BAD_REQUEST);
  }
  if (!ALLOWED_COMMENT_AUDIO_CONTENT_TYPES.has(file.type)) {
    return c.json({ message: 'Unsupported audio content type' }, HttpStatusCodes.BAD_REQUEST);
  }

  const replyRaw = form.replyToCommentId;
  let replyToCommentId: number | null = null;
  if (replyRaw !== undefined && replyRaw !== '') {
    const parsedReply = Number(replyRaw);
    if (!Number.isInteger(parsedReply) || parsedReply < 1) {
      return c.json({ message: 'Invalid replyToCommentId' }, HttpStatusCodes.BAD_REQUEST);
    }
    replyToCommentId = parsedReply;
  }

  let anchor: CommentAnchorInput | null = null;
  if (replyToCommentId == null) {
    const anchorKind = String(form.anchorKind ?? '');
    const anchorParse = commentAnchorInputSchema.safeParse(
      anchorKind === 'verse'
        ? { kind: 'verse', bibleTextId: Number(form.bibleTextId) }
        : { kind: 'pericope', pericopeNumber: String(form.pericopeNumber ?? '') }
    );
    if (!anchorParse.success) {
      return c.json({ message: 'Invalid anchor' }, HttpStatusCodes.BAD_REQUEST);
    }
    anchor = anchorParse.data;
  }

  const durationRaw = form.durationSeconds;
  const durationSeconds =
    durationRaw === undefined || durationRaw === '' ? null : Number(durationRaw);

  const data = Buffer.from(await file.arrayBuffer());
  const result = await draftCommentsService.createAudioComment(
    { id: user.id, grants: user.grants },
    chapterAssignmentId,
    anchor,
    { data, contentType: file.type, durationSeconds },
    null,
    replyToCommentId
  );
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.CREATED);
});

const replyRoute = createRoute({
  method: 'post',
  path: '/chapter-assignments/{chapterAssignmentId}/comments/replies',
  tags: ['Draft comments'],
  summary: 'Create a one-level reply (further replies flatten to root)',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.COMMENT_WRITE, scopeFromChapterAssignment),
  ] as const,
  request: {
    params: assignmentParams,
    body: jsonContentRequired(createReplyRequestSchema, 'Reply'),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(chapterCommentResponseSchema, 'Created'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(errorMessage, 'Unauthorized'),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(errorMessage, 'Forbidden'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(errorMessage, 'Not found'),
  },
});

server.openapi(replyRoute, async (c) => {
  const { chapterAssignmentId } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user')!;
  const result = await draftCommentsService.createReply(
    { id: user.id, grants: user.grants },
    chapterAssignmentId,
    body
  );
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.CREATED);
});

const setReactionRoute = createRoute({
  method: 'put',
  path: '/chapter-assignments/{chapterAssignmentId}/comments/{commentId}/reaction',
  tags: ['Draft comments'],
  summary: 'Set/replace reaction; same emoji toggles clear (atomic DB serialization)',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.COMMENT_WRITE, scopeFromChapterAssignment),
  ] as const,
  request: {
    params: commentParams,
    body: jsonContentRequired(setReactionRequestSchema, 'Reaction'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ emoji: z.string().nullable() }),
      'Active emoji or null if cleared'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(errorMessage, 'Unauthorized'),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(errorMessage, 'Forbidden'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(errorMessage, 'Not found'),
  },
});

server.openapi(setReactionRoute, async (c) => {
  const { chapterAssignmentId, commentId } = c.req.valid('param');
  const { emoji } = c.req.valid('json');
  const user = c.get('user')!;
  const result = await draftCommentsService.setReaction(
    { id: user.id, grants: user.grants },
    chapterAssignmentId,
    commentId,
    emoji
  );
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});

const clearReactionRoute = createRoute({
  method: 'delete',
  path: '/chapter-assignments/{chapterAssignmentId}/comments/{commentId}/reaction',
  tags: ['Draft comments'],
  summary: 'Explicitly clear the caller reaction',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.COMMENT_WRITE, scopeFromChapterAssignment),
  ] as const,
  request: { params: commentParams },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ cleared: z.literal(true) }), 'Cleared'),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(errorMessage, 'Unauthorized'),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(errorMessage, 'Forbidden'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(errorMessage, 'Not found'),
  },
});

server.openapi(clearReactionRoute, async (c) => {
  const { chapterAssignmentId, commentId } = c.req.valid('param');
  const user = c.get('user')!;
  const result = await draftCommentsService.clearReaction(
    { id: user.id, grants: user.grants },
    chapterAssignmentId,
    commentId
  );
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});
