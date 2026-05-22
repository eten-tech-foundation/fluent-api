import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { server } from '@/server/server';

/**
 * This route is defined solely for OpenAPI documentation.
 * The actual request handling is performed by the BetterAuth catch-all handler
 * in src/server/server.ts.
 */
const signInRoute = createRoute({
  tags: ['Authentication'],
  method: 'post',
  path: '/api/auth/sign-in/email',
  request: {
    body: jsonContent(
      z.object({
        email: z.string().email().openapi({ example: 'user@example.com' }),
        password: z.string().openapi({ example: 'password123' }),
      }),
      'Login credentials'
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        user: z.object({
          id: z.string(),
          email: z.string(),
          emailVerified: z.boolean(),
          name: z.string().nullable(),
          createdAt: z.string().datetime(),
          updatedAt: z.string().datetime(),
        }),
        session: z.object({
          id: z.string(),
          createdAt: z.string().datetime(),
          updatedAt: z.string().datetime(),
          userId: z.string(),
          expiresAt: z.string().datetime(),
          token: z.string(),
          ipAddress: z.string().nullable(),
          userAgent: z.string().nullable(),
        }),
        token: z.string().openapi({ description: 'The session token for Bearer authentication' }),
      }),
      'Login successful'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Invalid credentials'
    ),
  },
  summary: 'Sign in with Email',
  description:
    'Exchanges email and password for a session and token. Copy the "token" from the response and paste it into the "Authorize" box at the top to authenticate other requests.',
});

server.openapi(signInRoute, async (c) => {
  // This handler will likely never be reached because the catch-all /api/auth/*
  // in server.ts is registered first and will handle the request.
  return c.json({} as any, HttpStatusCodes.OK);
});
