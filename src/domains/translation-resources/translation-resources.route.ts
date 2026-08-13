import type { Context } from 'hono';

import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import type { AppBindings, AppError } from '@/lib/types';

import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { PERMISSIONS } from '@/lib/permissions';
import { ErrorCode, ErrorMessages, getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as translationResourcesService from './translation-resources.service';
import {
  languageCodeQuerySchema,
  manifestQuerySchema,
  prepareOfflineManifestResponseSchema,
  projectIdParamSchema,
  translationImagesResponseSchema,
  translationNotesResponseSchema,
  translationQuestionsResponseSchema,
  verseResourceParamSchema,
} from './translation-resources.types';

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
  'Project not found or inaccessible'
);
const badGatewayResponse = jsonContent(
  createMessageObjectSchema('Aquifer service is unavailable'),
  'Upstream Aquifer failure'
);
const internalErrorResponse = jsonContent(
  createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
  'Internal server error'
);

function aquiferErrorResponse(c: Context<AppBindings>, error: AppError) {
  if (error.code === ErrorCode.AQUIFER_SERVICE_UNAVAILABLE) {
    c.get('logger').error(
      { aquiferError: error.message, code: error.code },
      'Aquifer upstream failure'
    );
    return c.json(
      { message: ErrorMessages[ErrorCode.AQUIFER_SERVICE_UNAVAILABLE] },
      getHttpStatus(error) as never
    );
  }
  return c.json({ message: error.message }, getHttpStatus(error) as never);
}

// ─── GET /projects/{projectId}/translation-resources/notes/{bookCode}/{chapter}/{verse}

const getNotesRoute = createRoute({
  tags: ['Translation Resources'],
  method: 'get',
  path: '/projects/{projectId}/translation-resources/notes/{bookCode}/{chapter}/{verse}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'Get Translation Notes for a verse',
  description:
    'Proxies Aquifer UWTranslationNotes for the given scripture reference. Returns an empty items array when none exist. Aquifer failures are section-scoped (502).',
  request: {
    params: verseResourceParamSchema,
    query: languageCodeQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      translationNotesResponseSchema,
      'Translation Notes for the verse'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.NOT_FOUND]: notFoundResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getNotesRoute, async (c) => {
  const { bookCode, chapter, verse } = c.req.valid('param');
  const { languageCode } = c.req.valid('query');
  const result = await translationResourcesService.getTranslationNotes({
    bookCode,
    chapter,
    verse,
    languageCode,
  });
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return aquiferErrorResponse(c, result.error);
});

// ─── GET .../questions/{bookCode}/{chapter}/{verse}

const getQuestionsRoute = createRoute({
  tags: ['Translation Resources'],
  method: 'get',
  path: '/projects/{projectId}/translation-resources/questions/{bookCode}/{chapter}/{verse}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'Get Translation Questions for a verse',
  description:
    'Proxies Aquifer UWTranslationQuestions. TipTap content is preserved; Q/A splitting remains a client concern. Empty items when none exist.',
  request: {
    params: verseResourceParamSchema,
    query: languageCodeQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      translationQuestionsResponseSchema,
      'Translation Questions for the verse'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.NOT_FOUND]: notFoundResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getQuestionsRoute, async (c) => {
  const { bookCode, chapter, verse } = c.req.valid('param');
  const { languageCode } = c.req.valid('query');
  const result = await translationResourcesService.getTranslationQuestions({
    bookCode,
    chapter,
    verse,
    languageCode,
  });
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return aquiferErrorResponse(c, result.error);
});

// ─── GET .../images/{bookCode}/{chapter}/{verse}

const getImagesRoute = createRoute({
  tags: ['Translation Resources'],
  method: 'get',
  path: '/projects/{projectId}/translation-resources/images/{bookCode}/{chapter}/{verse}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'Get Images & Maps for a verse',
  description:
    'Proxies Aquifer Images resource type and hydrates asset URLs from resource details. Empty items when none exist.',
  request: {
    params: verseResourceParamSchema,
    query: languageCodeQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      translationImagesResponseSchema,
      'Images & Maps for the verse'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.NOT_FOUND]: notFoundResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getImagesRoute, async (c) => {
  const { bookCode, chapter, verse } = c.req.valid('param');
  const { languageCode } = c.req.valid('query');
  const result = await translationResourcesService.getTranslationImages({
    bookCode,
    chapter,
    verse,
    languageCode,
  });
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return aquiferErrorResponse(c, result.error);
});

// ─── GET .../manifest

const getManifestRoute = createRoute({
  tags: ['Translation Resources'],
  method: 'get',
  path: '/projects/{projectId}/translation-resources/manifest',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
  ] as const,
  summary: 'Prepare Offline resource manifest for a chapter range',
  description:
    'Returns Aquifer-backed download metadata (ids, sizes, URLs) for TN, TW, TQ, StudyNotes, and Images across a book chapter range. Text bodies are omitted unless includeContent=true. Empty items when none exist.',
  request: {
    params: projectIdParamSchema,
    query: manifestQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      prepareOfflineManifestResponseSchema,
      'Prepare Offline resource manifest'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.NOT_FOUND]: notFoundResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getManifestRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const { languageCode, bookCode, startChapter, endChapter, includeContent } = c.req.valid('query');
  const result = await translationResourcesService.getPrepareOfflineManifest({
    projectId,
    languageCode,
    bookCode,
    startChapter,
    endChapter,
    includeContent,
  });
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return aquiferErrorResponse(c, result.error);
});
