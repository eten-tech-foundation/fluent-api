import type { MiddlewareHandler } from 'hono';

import { createRemoteJWKSet, jwtVerify } from 'jose';

import type { Auth0JWTPayload } from '@/lib/types';

import env from '@/env';

const jwks = createRemoteJWKSet(new URL(`https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`));

export const auth0Middleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }
  const token = authHeader.replace('Bearer ', '');
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${env.AUTH0_DOMAIN}/`,
      audience: env.AUTH0_AUDIENCE,
    });

    // Cast to Auth0JWTPayload for type safety
    c.set('jwtPayload', payload as Auth0JWTPayload);
    await next();
  } catch (error) {
    return c.json({ error: 'Invalid or expired token', details: (error as Error).message }, 401);
  }
};
