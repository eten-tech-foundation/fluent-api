import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as booksService from './books.service';
import { bookResponseSchema } from './books.types';

const idParam = z.object({
  id: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'id', in: 'path', required: true },
      description: 'Book ID',
      example: 1,
    }),
});
const codeParam = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .openapi({
      param: { name: 'code', in: 'path', required: true },
      description: 'Book USFM code',
      example: 'GEN',
    }),
});

const listBooksRoute = createRoute({
  tags: ['Books'],
  method: 'get',
  path: '/books',
  middleware: [authenticateUser] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      bookResponseSchema.array().openapi('Books'),
      'The list of books'
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
  summary: 'Get all books',
  description: 'Returns a list of all books',
});

server.openapi(listBooksRoute, async (c) => {
  const result = await booksService.getAllBooks();
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

const getOldTestamentBooksRoute = createRoute({
  tags: ['Books'],
  method: 'get',
  path: '/books/old-testament',
  middleware: [authenticateUser] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      bookResponseSchema.array().openapi('OldTestamentBooks'),
      'The list of Old Testament books'
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
  summary: 'Get Old Testament books',
  description: 'Returns a list of Old Testament books (39 books)',
});

server.openapi(getOldTestamentBooksRoute, async (c) => {
  const result = await booksService.getOldTestamentBooks();
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

const getNewTestamentBooksRoute = createRoute({
  tags: ['Books'],
  method: 'get',
  path: '/books/new-testament',
  middleware: [authenticateUser] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      bookResponseSchema.array().openapi('NewTestamentBooks'),
      'The list of New Testament books'
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
  summary: 'Get New Testament books',
  description: 'Returns a list of New Testament books (27 books)',
});

server.openapi(getNewTestamentBooksRoute, async (c) => {
  const result = await booksService.getNewTestamentBooks();
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

const getBookByIdRoute = createRoute({
  tags: ['Books'],
  method: 'get',
  path: '/books/{id}',
  middleware: [authenticateUser] as const,
  request: { params: idParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(bookResponseSchema.openapi('Book'), 'The requested book'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Book not found'
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
  summary: 'Get a book by ID',
  description: 'Returns a single book by its ID',
});

server.openapi(getBookByIdRoute, async (c) => {
  const { id } = c.req.valid('param');
  const result = await booksService.getBookById(id);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

const getBookByCodeRoute = createRoute({
  tags: ['Books'],
  method: 'get',
  path: '/books/code/{code}',
  middleware: [authenticateUser] as const,
  request: { params: codeParam },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(bookResponseSchema.openapi('Book'), 'The requested book'),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
      'Book not found'
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
  summary: 'Get a book by code',
  description: 'Returns a single book by its USFM code (e.g. GEN, MAT)',
});

server.openapi(getBookByCodeRoute, async (c) => {
  const { code } = c.req.valid('param');
  const result = await booksService.getBookByCode(code);
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
