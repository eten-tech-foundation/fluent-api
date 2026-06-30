import { createRoute } from '@hono/zod-openapi';
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
