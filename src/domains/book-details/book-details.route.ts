import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireProjectUnitAccess } from '../usfm/usfm-auth.middleware';
import * as bookDetailsService from './book-details.service';
import { bookDetailsListSchema, bookDetailsSchema, updateBookDetailsSchema } from './book-details.types';

const projectUnitIdParam = z.object({
  projectUnitId: z.coerce.number().openapi({
    param: { name: 'projectUnitId', in: 'path', required: true, allowReserved: false },
    description: 'Project unit ID',
    example: 1,
  }),
});

// ─── GET /project-units/:projectUnitId/book-details ──────────────────────────

const listBookDetailsRoute = createRoute({
  tags: ['Book Details'],
  method: 'get',
  path: '/project-units/{projectUnitId}/book-details',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectUnitAccess(),
  ] as const,
  request: {
    params: projectUnitIdParam,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      bookDetailsListSchema,
      'Book-level USFM fields for every book in the project unit'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Project not found'),
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
  summary: 'List book details for a project unit',
  description:
    'Returns the running header (\\h) and book title (\\mt1) authored for each book in the unit. Null fields fall back to the book display name in the USFM export.',
});

server.openapi(listBookDetailsRoute, async (c) => {
  const { projectUnitId } = c.req.valid('param');

  const result = await bookDetailsService.listBookDetails(projectUnitId);
  if (result.ok) {
    return c.json(result.data, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── PATCH /project-units/:projectUnitId/book-details/:bookId ────────────────

const updateBookDetailsRoute = createRoute({
  tags: ['Book Details'],
  method: 'patch',
  path: '/project-units/{projectUnitId}/book-details/{bookId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_UPDATE),
    requireProjectUnitAccess(),
  ] as const,
  request: {
    params: projectUnitIdParam.extend({
      bookId: z.coerce.number().openapi({
        param: { name: 'bookId', in: 'path', required: true, allowReserved: false },
        description: 'Book ID',
        example: 1,
      }),
    }),
    body: jsonContent(updateBookDetailsSchema, 'The book fields to update'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(bookDetailsSchema, 'The updated book details'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Project or book not found'
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
  summary: 'Update the running header and book title of a book',
  description:
    'Sets the USFM \\h and/or \\mt1 for one book of the unit. Sending null or an empty string clears a field back to the display-name fallback.',
});

server.openapi(updateBookDetailsRoute, async (c) => {
  const { projectUnitId, bookId } = c.req.valid('param');
  const input = c.req.valid('json');

  const result = await bookDetailsService.updateBookDetails(projectUnitId, bookId, input);
  if (result.ok) {
    return c.json(result.data, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
