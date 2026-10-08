import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { getHttpStatus } from '@/lib/types';
import { updatedAfterQuerySchema, validationErrorSchema } from '@/lib/updated-after-query';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as languageService from './languages.service';
import { languageResponseSchema } from './languages.types';

const listLanguagesRoute = createRoute({
  tags: ['Languages'],
  method: 'get',
  path: '/languages',
  middleware: [authenticateUser] as const,
  request: {
    query: z.object({
      updatedAfter: updatedAfterQuerySchema,
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      languageResponseSchema.array().openapi('Languages'),
      'The list of languages'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      validationErrorSchema,
      'Invalid updatedAfter query parameter'
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
  summary: 'Get all languages',
  description:
    'Returns a list of all languages. When updatedAfter is provided, returns only languages updated after that ISO timestamp.',
});

server.openapi(listLanguagesRoute, async (c) => {
  const { updatedAfter } = c.req.valid('query');
  const result = await languageService.getAllLanguages(updatedAfter);

  if (result.ok) {
    return c.json(result.data, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

const getLanguageRoute = createRoute({
  tags: ['Languages'],
  method: 'get',
  path: '/languages/{id}',
  middleware: [authenticateUser] as const,
  request: {
    params: z.object({
      id: z.coerce
        .number()
        .int()
        .positive()
        .openapi({
          param: {
            name: 'id',
            in: 'path',
            required: true,
            allowReserved: false,
          },
          example: 1,
        }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(languageResponseSchema, 'The language'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Language not found'
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
  summary: 'Get a language by ID',
  description: 'Returns a single language by its ID',
});

server.openapi(getLanguageRoute, async (c) => {
  const { id } = c.req.valid('param');

  const result = await languageService.getLanguageById(id);

  if (result.ok) {
    return c.json(result.data, HttpStatusCodes.OK);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
