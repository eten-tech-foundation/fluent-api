import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

import type { AppEnv } from '@/server/context.types';

import { logger } from '@/lib/logger';

const processEmailFromUI = async (c: any, next: any) => {
  const emailFromUI = c.req.header('x-user-email');

  if (emailFromUI) {
    c.set('loggedInUserEmail', emailFromUI);
  }

  await next();
};

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

  app.use('*', cors());

  app.use('*', processEmailFromUI);

  app.use('*', async (c, next) => {
    c.set('logger', logger as any);
    await next();
  });

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;

    logger.info(`${c.req.method} ${c.req.path} - ${c.res.status} - ${duration}ms`);
  });

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
