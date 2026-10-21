import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { PERMISSIONS } from '@/lib/permissions';
import { aquiferErrorResponse } from '@/lib/services/aquifer/aquifer.errors';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as aquiferResourcesService from './aquifer-resources.service';
import {
  aquiferAssociationResponseSchema,
  aquiferBibleSchema,
  aquiferBibleTextResponseSchema,
  aquiferLanguageResourceCountSchema,
  aquiferLanguageSchema,
  aquiferResourceCollectionSchema,
  aquiferResourceDetailsSchema,
  aquiferResourceSearchResponseSchema,
  availableResourcesQuerySchema,
  biblesQuerySchema,
  bibleTextsParamSchema,
  bibleTextsQuerySchema,
  parentResourceIdParamSchema,
  resourceCollectionCodeParamSchema,
  resourceContentIdParamSchema,
  searchResourcesQuerySchema,
} from './aquifer-resources.types';

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
const badGatewayResponse = jsonContent(
  createMessageObjectSchema('Aquifer service is unavailable'),
  'Upstream Aquifer failure'
);
const internalErrorResponse = jsonContent(
  createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
  'Internal server error'
);

// ─── GET /aquifer/languages ───────────────────────────────────────────────

const getLanguagesRoute = createRoute({
  tags: ['Aquifer Resources'],
  method: 'get',
  path: '/aquifer/languages',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_VIEW)] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.array(aquiferLanguageSchema),
      'List of all Aquifer supported languages'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getLanguagesRoute, async (c) => {
  const result = await aquiferResourcesService.getLanguages();
  if (!result.ok) {
    return aquiferErrorResponse(c, result.error);
  }
  c.header('Cache-Control', 'private, max-age=300');
  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── GET /aquifer/languages/available-resources ──────────────────────────

const getAvailableResourcesRoute = createRoute({
  tags: ['Aquifer Resources'],
  method: 'get',
  path: '/aquifer/languages/available-resources',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_VIEW)] as const,
  request: {
    query: availableResourcesQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.array(aquiferLanguageResourceCountSchema),
      'Available resources count grouped by language'
    ),
    [HttpStatusCodes.BAD_REQUEST]: badRequestResponse,
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getAvailableResourcesRoute, async (c) => {
  const query = c.req.valid('query');
  const result = await aquiferResourcesService.getAvailableResources(query);
  if (!result.ok) {
    return aquiferErrorResponse(c, result.error);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── GET /aquifer/resources/collections/{code} ───────────────────────────

const getResourceCollectionRoute = createRoute({
  tags: ['Aquifer Resources'],
  method: 'get',
  path: '/aquifer/resources/collections/{code}',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_VIEW)] as const,
  request: {
    params: resourceCollectionCodeParamSchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      aquiferResourceCollectionSchema,
      'Aquifer resource collection details'
    ),
    [HttpStatusCodes.BAD_REQUEST]: badRequestResponse,
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getResourceCollectionRoute, async (c) => {
  const { code } = c.req.valid('param');
  const result = await aquiferResourcesService.getResourceCollection(code);
  if (!result.ok) {
    return aquiferErrorResponse(c, result.error);
  }
  c.header('Cache-Control', 'private, max-age=300');
  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── GET /aquifer/resources/search ───────────────────────────────────────

const searchResourcesRoute = createRoute({
  tags: ['Aquifer Resources'],
  method: 'get',
  path: '/aquifer/resources/search',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_VIEW)] as const,
  request: {
    query: searchResourcesQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      aquiferResourceSearchResponseSchema,
      'Search results for Aquifer resources'
    ),
    [HttpStatusCodes.BAD_REQUEST]: badRequestResponse,
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(searchResourcesRoute, async (c) => {
  const query = c.req.valid('query');
  const result = await aquiferResourcesService.searchResources(query);
  if (!result.ok) {
    return aquiferErrorResponse(c, result.error);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── GET /aquifer/resources/{contentId} ───────────────────────────────────

const getResourceRoute = createRoute({
  tags: ['Aquifer Resources'],
  method: 'get',
  path: '/aquifer/resources/{contentId}',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_VIEW)] as const,
  request: {
    params: resourceContentIdParamSchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(aquiferResourceDetailsSchema, 'Aquifer resource details'),
    [HttpStatusCodes.BAD_REQUEST]: badRequestResponse,
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getResourceRoute, async (c) => {
  const { contentId } = c.req.valid('param');
  const result = await aquiferResourcesService.getResource(contentId);
  if (!result.ok) {
    return aquiferErrorResponse(c, result.error);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── GET /aquifer/resources/{parentResourceId}/associations ──────────────

const getResourceAssociationsRoute = createRoute({
  tags: ['Aquifer Resources'],
  method: 'get',
  path: '/aquifer/resources/{parentResourceId}/associations',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_VIEW)] as const,
  request: {
    params: parentResourceIdParamSchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      aquiferAssociationResponseSchema,
      'Aquifer resource associations'
    ),
    [HttpStatusCodes.BAD_REQUEST]: badRequestResponse,
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getResourceAssociationsRoute, async (c) => {
  const { parentResourceId } = c.req.valid('param');
  const result = await aquiferResourcesService.getResourceAssociations(parentResourceId);
  if (!result.ok) {
    return aquiferErrorResponse(c, result.error);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── GET /aquifer/bibles ──────────────────────────────────────────────────

const getBiblesRoute = createRoute({
  tags: ['Aquifer Resources'],
  method: 'get',
  path: '/aquifer/bibles',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_VIEW)] as const,
  request: {
    query: biblesQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(aquiferBibleSchema), 'List of Aquifer Bibles'),
    [HttpStatusCodes.BAD_REQUEST]: badRequestResponse,
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getBiblesRoute, async (c) => {
  const query = c.req.valid('query');
  const result = await aquiferResourcesService.getBibles(query);
  if (!result.ok) {
    return aquiferErrorResponse(c, result.error);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── GET /aquifer/bibles/{bibleId}/texts ──────────────────────────────────

const getBibleTextsRoute = createRoute({
  tags: ['Aquifer Resources'],
  method: 'get',
  path: '/aquifer/bibles/{bibleId}/texts',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.CONTENT_VIEW)] as const,
  request: {
    params: bibleTextsParamSchema,
    query: bibleTextsQuerySchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      aquiferBibleTextResponseSchema,
      'Aquifer Bible text and optional audio'
    ),
    [HttpStatusCodes.BAD_REQUEST]: badRequestResponse,
    [HttpStatusCodes.UNAUTHORIZED]: unauthorizedResponse,
    [HttpStatusCodes.FORBIDDEN]: forbiddenResponse,
    [HttpStatusCodes.BAD_GATEWAY]: badGatewayResponse,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: internalErrorResponse,
  },
});

server.openapi(getBibleTextsRoute, async (c) => {
  const { bibleId } = c.req.valid('param');
  const query = c.req.valid('query');
  const result = await aquiferResourcesService.getBibleText(bibleId, query);
  if (!result.ok) {
    return aquiferErrorResponse(c, result.error);
  }
  return c.json(result.data, HttpStatusCodes.OK);
});
