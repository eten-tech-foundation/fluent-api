import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { PERMISSIONS } from '@/lib/permissions';
import { aquiferErrorResponse } from '@/lib/services/aquifer/aquifer.errors';
import { ErrorCode, getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as sourceAudioService from './source-audio.service';
import {
  chapterSourceAudioParamSchema,
  sourceAudioManifestQuerySchema,
  sourceAudioManifestResponseSchema,
  sourceAudioQuerySchema,
  sourceAudioResponseSchema,
} from './source-audio.types';

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
const notFoundResponse = jsonContent(
  createMessageObjectSchema('Not Found'),
  'Project or bible not found'
);
const badGatewayResponse = jsonContent(
  createMessageObjectSchema('Aquifer service is unavailable'),
  'Upstream Aquifer failure'
);
const internalErrorResponse = jsonContent(
  createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
  'Internal server error'
);

function sourceAudioErrorResponse(
  c: Parameters<typeof aquiferErrorResponse>[0],
  error: Parameters<typeof aquiferErrorResponse>[1]
) {
  if (error.code === ErrorCode.BIBLE_NOT_FOUND) {
    return c.json({ message: error.message }, getHttpStatus(error) as never);
  }
  if (error.code === ErrorCode.DBL_SERVICE_UNAVAILABLE) {
    c.get('logger').error({ dblError: error.message, code: error.code }, 'DBL upstream failure');
    return c.json({ message: error.message }, getHttpStatus(error) as never);
  }
  return aquiferErrorResponse(c, error);
}

// ─── GET /projects/{projectId}/source-audio/{bookCode}/{chapter}

const getChapterSourceAudioRoute = createRoute({
  tags: ['Source Audio'],
  method: 'get',
  path: '/projects/{projectId}/source-audio/{bookCode}/{chapter}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'Get source/reference audio for a chapter',
  description:
    'Returns playable chapter-level source audio URLs (DBL when the Fluent bible is linked, otherwise Aquifer). Empty `items` when no audio exists (HTTP 200). Distinct from translator `/verse-audio` draft recordings.',
  request: {
    params: chapterSourceAudioParamSchema,
    query: sourceAudioQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(sourceAudioResponseSchema, 'Source audio for the chapter'),
    [HttpStatusCodes.BAD_REQUEST]: badRequestResponse,
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.NOT_FOUND]: notFoundResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getChapterSourceAudioRoute, async (c) => {
  const { bookCode, chapter } = c.req.valid('param');
  const { languageCode, bibleId, verse } = c.req.valid('query');
  const result = await sourceAudioService.getChapterSourceAudio({
    languageCode,
    fluentBibleId: bibleId,
    bookCode,
    chapter,
    verse,
  });
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return sourceAudioErrorResponse(c, result.error);
});

// ─── GET /projects/{projectId}/source-audio/manifest

const getSourceAudioManifestRoute = createRoute({
  tags: ['Source Audio'],
  method: 'get',
  path: '/projects/{projectId}/source-audio/manifest',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'Prepare Offline Tier 1 source audio manifest',
  description:
    'Returns Aquifer-backed download metadata for source Bible audio across a chapter range (max 20 chapters). Empty `items` when no audio exists.',
  request: {
    params: chapterSourceAudioParamSchema.pick({ projectId: true }),
    query: sourceAudioManifestQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      sourceAudioManifestResponseSchema,
      'Tier 1 source audio manifest'
    ),
    [HttpStatusCodes.BAD_REQUEST]: badRequestResponse,
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.NOT_FOUND]: notFoundResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getSourceAudioManifestRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const { languageCode, bibleId, bookCode, startChapter, endChapter } = c.req.valid('query');
  const result = await sourceAudioService.getSourceAudioManifest({
    projectId,
    languageCode,
    fluentBibleId: bibleId,
    bookCode,
    startChapter,
    endChapter,
  });
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return sourceAudioErrorResponse(c, result.error);
});
