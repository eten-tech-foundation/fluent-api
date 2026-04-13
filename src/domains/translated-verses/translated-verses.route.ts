import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { insertTranslatedVersesSchema } from '@/db/schema';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireTranslatedVerseAccess } from './translated-verse-auth.middleware';
import * as translatedVersesService from './translated-verses.service';
import {
  PROJECT_UNIT_ID_SOURCES,
  TRANSLATED_VERSE_ACTIONS,
  translatedVerseResponseSchema,
} from './translated-verses.types';

// ─── GET /translated-verses/:id ───────────────────────────────────────────────

const getTranslatedVerseRoute = createRoute({
  tags: ['Translated Verses'],
  method: 'get',
  path: '/translated-verses/{id}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireTranslatedVerseAccess(
      TRANSLATED_VERSE_ACTIONS.READ,
      PROJECT_UNIT_ID_SOURCES.VERSE_PARAM,
      'id'
    ),
  ] as const,
  request: {
    params: z.object({
      id: z.coerce.number().openapi({
        param: { name: 'id', in: 'path', required: true, allowReserved: false },
        description: 'Translated verse ID',
        example: 77,
      }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(translatedVerseResponseSchema, 'The translated verse'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Translated verse not found'
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
  summary: 'Get a translated verse by ID',
  description: 'Returns a single translated verse by its translated_verses.id',
});

server.openapi(getTranslatedVerseRoute, async (c) => {
  const verse = c.get('translatedVerse')!;
  return c.json(verse, HttpStatusCodes.OK);
});

// ─── POST /translated-verses ──────────────────────────────────────────────────

const upsertTranslatedVerseRoute = createRoute({
  tags: ['Translated Verses'],
  method: 'post',
  path: '/translated-verses',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_UPDATE),
    requireTranslatedVerseAccess(TRANSLATED_VERSE_ACTIONS.EDIT, PROJECT_UNIT_ID_SOURCES.BODY),
  ] as const,
  request: {
    body: jsonContent(insertTranslatedVersesSchema, 'The translated verse to create or update'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      translatedVerseResponseSchema,
      'The created or updated translated verse'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Validation error or constraint violation'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Access denied'
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      z.object({
        success: z.boolean(),
        error: z.object({
          issues: z.array(
            z.object({ code: z.string(), path: z.array(z.string()), message: z.string() })
          ),
          name: z.string(),
        }),
      }),
      'The validation error'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Create or update a translated verse',
  description: 'Creates a new translated verse or updates an existing one. Translator only.',
});

server.openapi(upsertTranslatedVerseRoute, async (c) => {
  const translatedVerseData = c.req.valid('json');
  const currentUser = c.get('user')!;

  if (!translatedVerseData.assignedUserId) {
    translatedVerseData.assignedUserId = currentUser.id;
  }

  const result = await translatedVersesService.upsertTranslatedVerse(translatedVerseData);
  if (result.ok) {
    return c.json(result.data, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /translated-verses ───────────────────────────────────────────────────

const listTranslatedVersesRoute = createRoute({
  tags: ['Translated Verses'],
  method: 'get',
  path: '/translated-verses',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireTranslatedVerseAccess(TRANSLATED_VERSE_ACTIONS.READ, PROJECT_UNIT_ID_SOURCES.QUERY),
  ] as const,
  request: {
    query: z.object({
      projectUnitId: z.coerce
        .number()
        .int()
        .openapi({
          param: { name: 'projectUnitId', in: 'query', required: true },
          description: 'Filter by project unit ID (Required for authorization)',
          example: 24,
        }),
      bookId: z.coerce
        .number()
        .int()
        .optional()
        .openapi({
          param: { name: 'bookId', in: 'query', required: false },
          description: 'Filter by book ID',
          example: 1,
        }),
      chapterNumber: z.coerce
        .number()
        .int()
        .optional()
        .openapi({
          param: { name: 'chapterNumber', in: 'query', required: false },
          description: 'Filter by chapter number',
          example: 1,
        }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      translatedVerseResponseSchema.array().openapi('TranslatedVerses'),
      'The list of translated verses (optionally filtered)'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Project not found'
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
  summary: 'List translated verses',
  description: 'Returns a list of translated verses. projectUnitId is required for authorization.',
});

server.openapi(listTranslatedVersesRoute, async (c) => {
  const { projectUnitId, bookId, chapterNumber } = c.req.valid('query');

  const result = await translatedVersesService.listTranslatedVerses({
    projectUnitId,
    bookId,
    chapterNumber,
  });
  if (result.ok) {
    return c.json(result.data, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
