import type { Context, Next } from 'hono';

import env from '@/env';

export async function requireServiceAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.split(' ')[1];

  if (token !== env.AI_INBOUND_SERVICE_KEY) {
    return c.json({ error: 'Unauthorized: Invalid service key' }, 401);
  }

  await next();
}
