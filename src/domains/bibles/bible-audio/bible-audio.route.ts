import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as bibleAudioService from './bible-audio.service';
import { bibleAudioResponseSchema } from './bible-audio.types';

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

const getBibleAudioRoute = createRoute({
  tags: ['Bible Audio'],
  method: 'get',
  path: '/bibles/{bibleId}/books/{bookId}/chapters/{chapterNumber}/audio',
  middleware: [authenticateUser] as const,
  request: { params: chapterParams },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      bibleAudioResponseSchema.array().openapi('BibleAudioList'),
      'List of available source audio tracks for the chapter'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Invalid parameters'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Source audio not found or upstream unreachable'
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
  summary: 'Get source audio for chapter',
  description:
    'Returns the streaming URL for the source audio of a specific bible, book, and chapter',
});

server.openapi(getBibleAudioRoute, async (c) => {
  const { bibleId, bookId, chapterNumber } = c.req.valid('param');

  const result = await bibleAudioService.getSourceAudio(bibleId, bookId, chapterNumber);
  if (result.ok) {
    return c.json(result.data, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
