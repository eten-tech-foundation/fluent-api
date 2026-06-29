import type { Context } from 'hono';

import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

import type { AppEnv } from '@/server/context.types';

import { db } from '@/db';
import * as schema from '@/db/schema';
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
      // Expose set-auth-token so clients can read the Bearer token from the
      // BetterAuth bearer() plugin response header after sign-in.
      exposeHeaders: ['set-auth-token'],
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
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, x-client-type, x-better-auth-*',
        'Access-Control-Expose-Headers': 'set-auth-token',
        'Access-Control-Max-Age': '86400',
      },
    });
  });

  // ─── BetterAuth proxy helper ─────────────────────────────────────
  async function proxyToAuth(c: Context<AppEnv>, betterAuthPath: string): Promise<Response> {
    const url = new URL(c.req.url);
    url.pathname = betterAuthPath;
    return auth.handler(new Request(url, c.req.raw));
  }

  app.post('/api/auth/password/set', async (c) => {
    try {
      const { newPassword } = await c.req.json();
      await auth.api.setPassword({
        body: { newPassword },
        headers: c.req.raw.headers,
      });

      const session = await auth.api.getSession({
        headers: c.req.raw.headers,
      });

      if (session?.user?.email) {
        await db
          .update(schema.users)
          .set({ status: 'verified', updatedAt: new Date() })
          .where(eq(schema.users.email, session.user.email));
        logger.info(`User status updated to verified for email: ${session.user.email}`);
      } else {
        logger.warn(
          'Password set succeeded, but session or user email is missing. Skipped updating user status to verified.'
        );
      }

      return c.json({ success: true });
    } catch (err) {
      logger.error('Failed to set password:', err);
      return c.json(
        { message: err instanceof Error ? err.message : 'Failed to set password' },
        400
      );
    }
  });

  // POST /api/auth/forget-password
  app.post('/api/auth/forget-password', (c) => proxyToAuth(c, '/api/auth/request-password-reset'));

  app.get('/api/auth/validate-token', async (c) => {
    const token = c.req.query('token');
    if (!token) {
      return c.json({ isValid: false, message: 'Token is required' }, 400);
    }
    try {
      const [verification] = await db
        .select()
        .from(schema.authVerification)
        .where(eq(schema.authVerification.identifier, `reset-password:${token}`))
        .limit(1);

      if (!verification) {
        return c.json(
          {
            isValid: false,
            message: 'This password reset link is invalid or has already been used.',
          },
          410
        );
      }

      const isExpired = new Date(verification.expiresAt) < new Date();
      if (isExpired) {
        return c.json({ isValid: false, message: 'This password reset link has expired.' }, 410);
      }

      return c.json({ isValid: true });
    } catch (err) {
      logger.error('Failed to validate verification token', { error: err });
      return c.json({ isValid: false, message: 'Failed to validate token' }, 500);
    }
  });

  // POST /api/auth/sign-out
  app.post('/api/auth/sign-out', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();

      const [session] = await db
        .select({ id: schema.authSession.id, userId: schema.authSession.userId })
        .from(schema.authSession)
        .where(eq(schema.authSession.token, token))
        .limit(1);

      if (session) {
        await db.delete(schema.authSession).where(eq(schema.authSession.id, session.id));
        try {
          await db.insert(schema.authAuditLog).values({
            userId: session.userId,
            event: 'session.deleted',
            ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null,
            userAgent: c.req.header('user-agent') ?? null,
            metadata: { sessionId: session.id, via: 'mobile-bearer' },
          });
        } catch (auditErr) {
          logger.error('Failed to log audit event: session.deleted (mobile)', { error: auditErr });
        }
      }

      return c.json({ success: true });
    }

    // Cookie-based sign-out — delegate to BetterAuth
    return proxyToAuth(c, '/api/auth/sign-out');
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
