import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

import type { AppEnv } from '@/server/context.types';

import env from '@/env';
import { auth } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { authenticate } from '@/middlewares/authenticate';

export function createServer() {
  const app = new OpenAPIHono<AppEnv>({
    strict: false,
  });

  app.onError((err, c) => {
    // Pass through Hono HTTPExceptions with their intended status codes as JSON
    if (err instanceof HTTPException) {
      return c.json({ message: err.message }, err.status);
    }

    logger.error(`${err.message}`, err, {
      request: {
        method: c.req.method,
        path: c.req.path,
      },
    });
    return c.json({ message: 'Internal Server Error' }, 500);
  });
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;

    logger.info(`${c.req.method} ${c.req.path} - ${c.res.status} - ${duration}ms`);
  });

  app.use('*', async (c, next) => {
    c.set('logger', logger as any);
    await next();
  });
  // ─── CORS with credentials (criterion #5) ──────────────────────
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return null;
        if (origin === env.FRONTEND_URL || origin.endsWith('.fluent.bible')) {
          return origin;
        }
        return null;
      },
      credentials: true,
    })
  );

  // Handle preflight OPTIONS for all /api/auth/* routes
  app.options('/api/auth/*', (c) => {
    const origin = c.req.header('Origin') ?? null;
    const isAllowed =
      origin &&
      (origin === env.FRONTEND_URL.replace(/\/$/, '') || origin.endsWith('.fluent.bible'));
    if (!isAllowed) return c.text('Forbidden', 403);
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-better-auth-*',
        'Access-Control-Max-Age': '86400',
      },
    });
  });

  app.post('/api/auth/password/set', async (c) => {
    try {
      const body = await c.req.json();
      const result = await auth.api.setPassword({
        body,
        headers: c.req.raw.headers,
      });
      return c.json(result);
    } catch (err) {
      console.error('Password set error:', err);
      return c.json({ error: { message: 'Unauthorized or invalid request' } }, 401);
    }
  });

  app.all('/api/auth/*', (c) => {
    return auth.handler(c.req.raw);
  });

  app.use('*', authenticate);

  app.use('*', async (c, next) => {
    await next();

    if (c.req.method === 'GET' && !c.res.headers.get('Cache-Control')) {
      c.res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      c.res.headers.set('Pragma', 'no-cache');
      c.res.headers.set('Expires', '0');
    }
  });

  return app;
}

export const server = createServer();
