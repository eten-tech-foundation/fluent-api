import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent, jsonContentOneOf, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireBookDetailsAccess } from './book-details-auth.middleware';
import * as bookDetailsService from './book-details.service';
import {
  bookDetailsListSchema,
  bookDetailsSchema,
  updateBookDetailsSchema,
} from './book-details.types';

// `.int().positive()` on both path IDs, because `z.coerce.number()` alone accepts
// `1.5`. A fractional ID is not merely useless: it is bound to an `integer` column
// and Postgres rejects the parameter outright (SQLSTATE 22P02, "invalid input
// syntax for type integer"), which the repository catches and reports as an
// INTERNAL_ERROR — a 500 for what is plainly a bad request. Verified against a real
// Postgres: `1.5` throws, whereas a negative or merely absent ID matches no row and
// already yields the correct 404. So `.int()` is the fix and `.positive()` states
// the rule `requireBookDetailsAccess` enforces anyway, in the OpenAPI document too.
const projectUnitIdParam = z.object({
  projectUnitId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'projectUnitId', in: 'path', required: true, allowReserved: false },
      description: 'Project unit ID',
      example: 1,
    }),
});

// The body zod rejects with. This app wires no defaultHook (nothing imports
// src/lib/create-app.ts, and src/server/server.ts constructs OpenAPIHono without
// one), so @hono/zod-validator falls through to `c.json(result, 400)` and this
// shape is served with a 400 rather than the 422 the hook would produce.
const validationErrorSchema = z.object({
  success: z.boolean(),
  error: z.object({
    issues: z.array(z.object({ code: z.string(), path: z.array(z.string()), message: z.string() })),
    name: z.string(),
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
    requireBookDetailsAccess(),
  ] as const,
  request: {
    params: projectUnitIdParam,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      bookDetailsListSchema,
      'Book-level USFM fields for every book in the project unit'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.BAD_REQUEST),
      'Invalid path parameter'
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
  description: [
    'Returns the book-level USFM fields authored for each book in the unit: the running header (\\h), the legacy book title (\\mt) and the three table-of-contents fields (\\toc1 long name, \\toc2 short name, \\toc3 abbreviation).',
    'Export precedence: \\mt is tocShortName, else bookTitle, else the book display name; \\h is runningHeader, else tocShortName, else the book display name. A null or blank \\toc field omits its line from the export entirely — the \\toc fields have no display-name fallback.',
    'Pre-population rule for the metadata dialog: when tocShortName is null and bookTitle is not, seed the Short Name input from bookTitle. Long Name and Abbreviation are never pre-populated. bookTitle itself is never written by a TOC edit, so clearing Short Name again reveals the preserved legacy \\mt rather than falling through to the display name.',
  ].join(' '),
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
    requireBookDetailsAccess(),
  ] as const,
  request: {
    params: projectUnitIdParam.extend({
      // Unlike projectUnitId, no middleware re-checks bookId, so the validator is
      // the only thing standing between a fractional ID and the repository.
      bookId: z.coerce
        .number()
        .int()
        .positive()
        .openapi({
          param: { name: 'bookId', in: 'path', required: true, allowReserved: false },
          description: 'Book ID',
          example: 1,
        }),
    }),
    // Required, so a request with no Content-Type (or a non-JSON one) is rejected
    // by the validator instead of reaching the handler as `{}` — which would send
    // an empty `set` into drizzle and 500.
    body: jsonContentRequired(updateBookDetailsSchema, 'The book fields to update'),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(bookDetailsSchema, 'The updated book details'),
    [HttpStatusCodes.BAD_REQUEST]: jsonContentOneOf(
      [validationErrorSchema, createMessageObjectSchema('Malformed JSON in request body')],
      'Body failed schema validation, or the JSON was malformed'
    ),
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
    // Declared defensively: no defaultHook is wired today, so validation failures
    // surface as the 400 above. This entry becomes the real one the moment one is.
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      validationErrorSchema,
      'The validation error'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
  summary: 'Update the book-level USFM fields of a book',
  description: [
    'Sets any of the running header (\\h), the legacy book title (\\mt) and the table-of-contents fields (\\toc1 long name, \\toc2 short name, \\toc3 abbreviation) for one book of the unit. Only the fields named in the body are written; sending null or an empty string clears a field.',
    'Export precedence: \\mt is tocShortName, else bookTitle, else the book display name; \\h is runningHeader, else tocShortName, else the book display name. \\mt is therefore derived at render time from the Short Name — this endpoint never writes bookTitle as a side effect of a TOC edit, so an existing \\mt is preserved and reappears in the export if the Short Name is later cleared. A null or blank \\toc field omits its line; the \\toc fields have no display-name fallback.',
    'Authorization: gated on content:update plus project read access, i.e. a translator assigned to the project may edit these fields. Inherited from #263 and open for review.',
  ].join(' '),
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
