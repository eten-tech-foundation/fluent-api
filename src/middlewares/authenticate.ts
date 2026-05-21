import type { Context, Next } from 'hono';

import type { AppBindings } from '@/lib/types';

import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { logger } from '@/lib/logger';

/**
 * Authentication Middleware
 *
 * Validates the session via BetterAuth and populates the context with:
 * - 'session': The BetterAuth session object
 * - 'user': The application user record linked via email
 */
export async function authenticate(c: Context<AppBindings>, next: Next) {
  // Skip auth routes to avoid circularity if applied globally
  if (c.req.path.startsWith('/api/auth')) {
    return next();
  }

  try {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!session) {
      return next();
    }

    c.set('session', session as any);

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
    logger.error('Authentication middleware error', { error });
  }

  await next();
}
