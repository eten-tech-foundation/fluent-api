import { createRoute, z } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as pericopeService from './pericopes.service';
import {
  chapterPericopesParamSchema,
  chapterPericopesResponseSchema,
  pericopeSetParamSchema,
  pericopeSetQuerySchema,
  pericopeSetResponseSchema,
  pericopeSetSchema,
} from './pericopes.types';

// ─── GET /pericope-sets ───────────────────────────────────────────────────────

const listPericopeSetsRoute = createRoute({
  tags: ['Pericopes'],
  method: 'get',
  path: '/pericope-sets',
  middleware: [authenticateUser] as const,
  summary: 'List available pericope sets',
  responses: {
    [HttpStatusCodes.OK]: jsonContent(pericopeSetSchema.array(), 'List of pericope sets'),
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
});

server.openapi(listPericopeSetsRoute, async (c) => {
  const result = await pericopeService.listPericopeSets();
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

// ─── GET /pericope-sets/:id ───────────────────────────────────────────────────

const pericopeSetCacheHeaders = z.object({
  ETag: z.string().describe('Strong SHA-256 entity tag of the returned JSON representation.'),
  'Cache-Control': z
    .string()
    .describe('private, no-cache: store privately and revalidate before reuse.'),
});

const getPericopeSetRoute = createRoute({
  tags: ['Pericopes'],
  method: 'get',
  path: '/pericope-sets/{id}',
  middleware: [authenticateUser] as const,
  summary: 'Get all pericope groups in a set',
  description:
    'Returns complete groups, including references across chapters, ordered by book ID and first verse. ' +
    'Each group includes bookCode; pericopeNumber is scoped to that book and includes the FCBH section prefix. ' +
    'An optional bookCode limits the response to one book. Existing sets without matching verses return an empty array; ' +
    'unknown set IDs or book codes return 404. The strong ETag hashes the exact JSON response, including titles and references. ' +
    'Send If-None-Match to revalidate: matching strong or weak tags, a matching tag in a list, or * return 304 with no body. ' +
    'Authentication and validation are required for both 200 and 304 responses.',
  request: {
    params: pericopeSetParamSchema,
    query: pericopeSetQuerySchema,
    headers: z.object({
      'if-none-match': z.string().optional().openapi({
        description: 'Previously received ETag, a comma-separated list of entity tags, or *.',
      }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      ...jsonContent(pericopeSetResponseSchema, 'Pericope groups for the set or selected book'),
      headers: pericopeSetCacheHeaders,
    },
    [HttpStatusCodes.NOT_MODIFIED]: {
      description: 'The representation matches If-None-Match. No response body.',
      headers: pericopeSetCacheHeaders,
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      description: 'Invalid set ID or bookCode.',
    },
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Pericope set or book not found'
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
});

server.openapi(getPericopeSetRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { bookCode } = c.req.valid('query');
  const result = await pericopeService.getPericopeSet(id, bookCode);
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  const etag = `"${createHash('sha256').update(JSON.stringify(result.data)).digest('hex')}"`;
  c.header('ETag', etag);
  c.header('Cache-Control', 'private, no-cache');

  const ifNoneMatch = c.req.header('If-None-Match');
  const matches =
    ifNoneMatch?.trim() === '*' ||
    ifNoneMatch?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
  if (matches) return c.body(null, HttpStatusCodes.NOT_MODIFIED);

  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── GET /projects/:id/pericopes/:bookCode/:chapter ───────────────────────────

const getChapterPericopesRoute = createRoute({
  tags: ['Pericopes'],
  method: 'get',
  path: '/projects/{id}/pericopes/{bookCode}/{chapter}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ),
  ] as const,
  summary: 'Get pericope groupings for a chapter',
  description:
    'Returns empty array if project has no pericope set or book is not covered (fallback to verse mode).',
  request: { params: chapterPericopesParamSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      chapterPericopesResponseSchema,
      'Pericope groups for chapter'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Not Found'),
      'Book not found'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Insufficient permissions'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'Internal server error'
    ),
  },
});

server.openapi(getChapterPericopesRoute, async (c) => {
  const { id, bookCode, chapter } = c.req.valid('param');
  const result = await pericopeService.getChapterPericopes(id, bookCode, chapter);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
