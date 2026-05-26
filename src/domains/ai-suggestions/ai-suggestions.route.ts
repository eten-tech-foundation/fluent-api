import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as aiSuggestionsService from './ai-suggestions.service';
import {
  aiSuggestionsListResponseSchema,
  getAiSuggestionsQuerySchema,
  queueNextVersesRequestSchema,
  trackUsageRequestSchema,
} from './ai-suggestions.types';

// ─── GET /ai-suggestions ──────────────────────────────────────────────

const getAiSuggestionsRoute = createRoute({
  tags: ['AI Suggestions'],
  method: 'get',
  path: '/ai-suggestions',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.PROJECT_VIEW)] as const,
  request: {
    query: getAiSuggestionsQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(aiSuggestionsListResponseSchema, 'List of AI suggestions'),
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
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get pre-generated AI suggestions',
  description: 'Retrieves AI suggestions for the specified bible text IDs.',
});

server.openapi(getAiSuggestionsRoute, async (c) => {
  const query = c.req.valid('query');
  const user = c.get('user');

  if (!user) {
    return c.json({ message: 'User not found' }, HttpStatusCodes.UNAUTHORIZED);
  }

  const result = await aiSuggestionsService.getAiSuggestions(user, query);
  if (result.ok) {
    return c.json(result.data, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── POST /ai-suggestions/queue-next ──────────────────────────────────────────

const queueNextVersesRoute = createRoute({
  tags: ['AI Suggestions'],
  method: 'post',
  path: '/ai-suggestions/queue-next',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.PROJECT_VIEW)] as const,
  request: {
    body: jsonContent(queueNextVersesRequestSchema, 'Verses context'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(createMessageObjectSchema('Successfully queued'), 'Queued'),
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
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Queue pre-generation of AI suggestions',
  description:
    'Triggers the queue to generate suggestions for the next few verses ahead of the drafter.',
});

server.openapi(queueNextVersesRoute, async (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  if (!user) {
    return c.json({ message: 'User not found' }, HttpStatusCodes.UNAUTHORIZED);
  }

  const result = await aiSuggestionsService.queueNextVerses(
    user,
    body.projectUnitId,
    body.bibleId,
    body.bookCode,
    body.chapterNumber,
    body.currentVerse,
    body.lookahead
  );
  if (result.ok) {
    return c.json({ message: 'Queued' }, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── POST /ai-suggestions/usage ──────────────────────────────────────────────

const trackUsageRoute = createRoute({
  tags: ['AI Suggestions'],
  method: 'post',
  path: '/ai-suggestions/usage',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.PROJECT_VIEW)] as const,
  request: {
    body: jsonContent(trackUsageRequestSchema, 'Usage data'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(createMessageObjectSchema('Successfully logged'), 'Logged'),
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
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Track AI suggestion usage',
  description: 'Logs whether an AI suggestion was viewed or used by the user.',
});

server.openapi(trackUsageRoute, async (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  if (!user?.id) {
    return c.json({ message: 'User not found' }, HttpStatusCodes.UNAUTHORIZED);
  }

  const result = await aiSuggestionsService.trackUsage(user, body);
  if (result.ok) {
    return c.json({ message: 'Logged' }, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
