import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { PERMISSIONS } from '@/lib/permissions';
import { youVersionErrorResponse } from '@/lib/services/youversion/youversion.errors';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as youVersionService from './youversion.service';
import {
  biblesQuerySchema,
  chapterTextParamSchema,
  chapterTextQuerySchema,
  youVersionBibleSchema,
  youVersionChapterTextSchema,
} from './youversion.types';

const badRequestResponse = jsonContent(
  createMessageObjectSchema('Bad Request'),
  'Invalid request parameters'
);
const unauthorizedResponse = jsonContent(
  createMessageObjectSchema('Unauthorized'),
  'Authentication required'
);
const forbiddenResponse = jsonContent(
  createMessageObjectSchema('Forbidden'),
  'Insufficient permissions'
);
const badGatewayResponse = jsonContent(
  createMessageObjectSchema('YouVersion service is unavailable'),
  'Upstream YouVersion failure'
);
const internalErrorResponse = jsonContent(
  createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
  'Internal server error'
);

// ─── GET /youversion/bibles ───────────────────────────────────────────────────

const getBiblesRoute = createRoute({
  tags: ['YouVersion'],
  method: 'get',
  path: '/youversion/bibles',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_VIEW)] as const,
  request: {
    query: biblesQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.array(youVersionBibleSchema),
      'List of YouVersion Bibles for the requested language'
    ),
    [HttpStatusCodes.BAD_REQUEST]: badRequestResponse,
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getBiblesRoute, async (c) => {
  const { language_tag } = c.req.valid('query');
  const result = await youVersionService.getBibles(language_tag);
  if (!result.ok) {
    return youVersionErrorResponse(c, result.error);
  }
  c.header('Cache-Control', 'private, max-age=300');
  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── GET /youversion/bibles/{bibleId}/chapters/{chapterId}/text ───────────────

const getChapterTextRoute = createRoute({
  tags: ['YouVersion'],
  method: 'get',
  path: '/youversion/bibles/{bibleId}/chapters/{chapterId}/text',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_VIEW)] as const,
  request: {
    params: chapterTextParamSchema,
    query: chapterTextQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      youVersionChapterTextSchema,
      'All verse texts for the requested chapter (server-side fan-out)'
    ),
    [HttpStatusCodes.BAD_REQUEST]: badRequestResponse,
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getChapterTextRoute, async (c) => {
  const { bibleId, chapterId } = c.req.valid('param');
  const { bookId } = c.req.valid('query');
  const result = await youVersionService.getChapterText(bibleId, bookId, chapterId);
  if (!result.ok) {
    return youVersionErrorResponse(c, result.error);
  }
  c.header('Cache-Control', 'private, max-age=300');
  return c.json(result.data, HttpStatusCodes.OK);
});
