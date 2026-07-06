import type { Context, Next } from 'hono';

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

import env from '@/env';

export async function requireServiceAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.split(' ')[1];

  const expected = Buffer.from(env.AI_INBOUND_SERVICE_KEY);
  const actual = Buffer.from(token.padEnd(expected.length, '\0'));

  if (actual.length !== expected.length) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!timingSafeEqual(actual, expected)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
}
