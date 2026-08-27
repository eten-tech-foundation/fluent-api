import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as bibleBooksService from './bible-books.service';
import { bibleBookDetailResponseSchema } from './bible-books.types';

const bibleIdParam = z.object({
  bibleId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'bibleId', in: 'path', required: true },
      description: 'Bible ID',
      example: 1,
    }),
});

const listBibleBooksRoute = createRoute({
  tags: ['Bible Books'],
  method: 'get',
  path: '/bible-books/bible/{bibleId}',
  middleware: [authenticateUser] as const,
  request: { params: bibleIdParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      bibleBookDetailResponseSchema.array().openapi('BibleBooks'),
      'The list of books for this bible'
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
  summary: 'Get books by bible ID',
  description:
    'Returns all books associated with a specific bible, including book and bible details',
});

server.openapi(listBibleBooksRoute, async (c) => {
  const { bibleId } = c.req.valid('param');
  const result = await bibleBooksService.getBibleBooksByBibleId(bibleId);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
