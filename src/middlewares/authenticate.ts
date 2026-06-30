import type { Context, Next } from 'hono';

import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';

import type { AppBindings } from '@/lib/types';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { logger } from '@/lib/logger';

const MOBILE_ROLLING_DAYS = 60;
const MOBILE_ROLLING_MS = MOBILE_ROLLING_DAYS * 24 * 60 * 60 * 1000;
const MOBILE_ROLL_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // Roll when < 30 days remain
const MOBILE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // Check at most once per 24h

/**
 * Authentication Middleware
 *
 * Validates the session via BetterAuth and populates the context with:
 * - 'session': The BetterAuth session object
 * - 'user': The application user record linked via email
 *
 * Granular Bearer token errors:
 * - Throws 401 "Invalid or revoked session token" if the token is not in DB.
 * - Throws 401 "Session token has expired" if the token exists but is expired.
 * - Only activates when an Authorization: Bearer header is present AND getSession() returns null.
 *   This preserves the passive middleware behaviour for all other routes.
 *
 * Mobile session rolling:
 * - If the session is flagged isMobile, checks once per 24h (using updatedAt as proxy).
 * - If remaining lifetime < 30 days, extends expiresAt by 60 days.
 */
export async function authenticate(c: Context<AppBindings>, next: Next) {
  // Skip auth routes to avoid circularity if applied globally
  // Skip internal routes as they use their own service authentication tokens
  if (c.req.path.startsWith('/api/auth') || c.req.path.startsWith('/internal')) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  const hasBearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ');

  try {
    let sessionHeaders = c.req.raw.headers;
    if (hasBearerToken) {
      const stripped = new Headers(c.req.raw.headers);
      stripped.delete('cookie');
      sessionHeaders = stripped;
    }

    const session = await auth.api.getSession({
      headers: sessionHeaders,
    });

    if (!session) {
      // Only throw specific errors when a Bearer token was explicitly supplied.
      // Requests without a token (e.g. public routes) pass through silently.
      if (hasBearerToken) {
        const token = authHeader.slice(7).trim();

        const [row] = await db
          .select({
            expiresAt: schema.authSession.expiresAt,
          })
          .from(schema.authSession)
          .where(eq(schema.authSession.token, token))
          .limit(1);

        if (!row) {
          throw new HTTPException(401, { message: 'Invalid or revoked session token' });
        }

        if (new Date(row.expiresAt) < new Date()) {
          throw new HTTPException(401, { message: 'Session token has expired' });
        }

        // Token is in DB and not expired, but getSession was rejected (revoked / invalid user)
        throw new HTTPException(401, { message: 'Invalid or revoked session token' });
      }

      return next();
    }

    c.set('session', session as any);

    // ── Mobile session rolling (24h-throttled) ──────────────────────────────
    // Only incur a DB read/write for mobile sessions, and only once per 24h.
    const rawSession = session.session as unknown as {
      id: string;
      updatedAt: Date | string;
      expiresAt: Date | string;
      isMobile?: boolean;
    };

    const updatedAt = new Date(rawSession.updatedAt);
    const staleCheck = Date.now() - updatedAt.getTime() > MOBILE_CHECK_INTERVAL_MS;

    if (staleCheck) {
      // One DB read — only executes at most once per 24h per mobile session
      const [dbSession] = await db
        .select({
          isMobile: schema.authSession.isMobile,
          expiresAt: schema.authSession.expiresAt,
        })
        .from(schema.authSession)
        .where(eq(schema.authSession.id, rawSession.id))
        .limit(1);

      if (dbSession?.isMobile) {
        const remainingMs = new Date(dbSession.expiresAt).getTime() - Date.now();
        if (remainingMs < MOBILE_ROLL_THRESHOLD_MS) {
          const newExpiry = new Date(Date.now() + MOBILE_ROLLING_MS);
          const now = new Date();
          await db
            .update(schema.authSession)
            .set({ expiresAt: newExpiry, updatedAt: now })
            .where(eq(schema.authSession.id, rawSession.id));

          logger.debug('Mobile session rolled: extended by 60 days', {
            sessionId: rawSession.id,
          });
        }
      }
    }
    // ───────────────────────────────────────────────────────────────────────

    // Look up the application user
    const userResult = await getUserByEmail(session.user.email);
    if (userResult.ok) {
      c.set('user', userResult.data);
    } else {
      logger.debug('Authenticated auth_user has no linked application user', {
        email: session.user.email,
      });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    logger.error('Authentication middleware error', { error });
  }

  await next();
}
