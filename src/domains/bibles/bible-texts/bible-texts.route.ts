import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import env from '@/env';
import { getHttpStatus } from '@/lib/types';
import { rateLimit } from '@/middlewares/rate-limit';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import type { BulkBibleTextsRequest } from './bible-texts.types';

import * as bibleTextsService from './bible-texts.service';
import {
  bibleTextResponseSchema,
  bulkBibleTextsResponseSchema,
  bulkChapterRequestSchema,
} from './bible-texts.types';

const chapterParams = z.object({
  bibleId: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({
      param: { name: 'bibleId', in: 'path', required: true },
      description: 'Bible ID',
      example: 1,
    }),
  bookId: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({
      param: { name: 'bookId', in: 'path', required: true },
      description: 'Book ID',
      example: 1,
    }),
  chapterNumber: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({
      param: { name: 'chapterNumber', in: 'path', required: true },
      description: 'Chapter number',
      example: 1,
    }),
});

// ─── GET /bibles/:bibleId/books/:bookId/chapters/:chapterNumber/texts ─────────

const getBibleTextsByChapterRoute = createRoute({
  tags: ['Bible Texts'],
  method: 'get',
  path: '/bibles/{bibleId}/books/{bookId}/chapters/{chapterNumber}/texts',
  middleware: [authenticateUser] as const,
  request: { params: chapterParams },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      bibleTextResponseSchema.array().openapi('BibleTexts'),
      'The list of bible texts for the chapter'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Invalid parameters'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Bible, book, or chapter not found'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'User account is inactive'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get bible texts by chapter',
  description: 'Returns a list of bible texts for a specific bible, book, and chapter',
});

server.openapi(getBibleTextsByChapterRoute, async (c) => {
  const { bibleId, bookId, chapterNumber } = c.req.valid('param');
  const result = await bibleTextsService.getBibleTextsByChapter(bibleId, bookId, chapterNumber);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── POST /bibles/:bibleId/bulk-texts ─────────────────────────────────────────

const getBulkBibleTextsRoute = createRoute({
  tags: ['Bible Texts'],
  method: 'post',
  path: '/bibles/{bibleId}/bulk-texts',
  // Intentionally anonymous (mobile sync pre-cache; reviewer decision 2026-06-26).
  // Rate-limited as a scraping/abuse guard — a full sync needs only 1-2 requests.
  middleware: [
    rateLimit({
      windowMs: env.RATE_LIMIT_BULK_TEXTS_WINDOW_MS,
      max: env.RATE_LIMIT_BULK_TEXTS_MAX,
    }),
  ] as const,
  request: {
    params: z.object({
      bibleId: z.coerce
        .number()
        .int()
        .min(1)
        .openapi({
          param: { name: 'bibleId', in: 'path', required: true },
          description: 'Bible ID',
          example: 1,
        }),
    }),
    body: jsonContentRequired(
      bulkChapterRequestSchema.openapi('BulkBibleTextsRequest'),
      'List of (bookId, chapterNumber) pairs to fetch in one request'
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      bulkBibleTextsResponseSchema.openapi('BulkBibleTexts'),
      'Bible texts grouped by book and chapter'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Invalid request body (chapters array empty or exceeds 1200)'
    ),
    [HttpStatusCodes.TOO_MANY_REQUESTS]: {
      ...jsonContent(
        createMessageObjectSchema('Too many requests'),
        // Read from env, not written out: the limits are deployment-configurable, so a fixed
        // number here would describe whatever the defaults happened to be when this was written.
        `Rate limit exceeded (${env.RATE_LIMIT_BULK_TEXTS_MAX} requests per ${
          env.RATE_LIMIT_BULK_TEXTS_WINDOW_MS / 1000
        }s per client IP)`
      ),
      headers: z.object({
        'Retry-After': z.string().openapi({
          description: 'Seconds until the current rate-limit window resets',
          example: '60',
        }),
      }),
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Get bible texts for multiple chapters (bulk)',
  description:
    'Returns bible texts grouped by chapter for up to 1200 (bookId, chapterNumber) pairs in a single request. ' +
    'Designed for mobile clients to pre-cache all assigned chapter texts in one round-trip. ' +
    'Intentionally requires no authentication (mobile sync feature); rate-limited per client IP as an abuse guard.',
});

server.openapi(getBulkBibleTextsRoute, async (c) => {
  const { bibleId } = c.req.valid('param');
  const body: BulkBibleTextsRequest = c.req.valid('json');
  const result = await bibleTextsService.getBulkBibleTexts(bibleId, body);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
