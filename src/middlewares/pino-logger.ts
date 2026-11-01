import { pinoLogger as logger } from 'hono-pino';
import pino from 'pino';
import pretty from 'pino-pretty';

import env from '@/env';

export function pinoLogger() {
  return logger({
    http: {
      // Keep HTTP logs to metadata: headers can contain credentials and receipts.
      onReqBindings: (c) => ({ req: { method: c.req.method, url: c.req.path } }),
      onResBindings: (c) => ({ res: { status: c.res.status } }),
      // Exception messages can contain request or provider payloads.
      onResMessage: (c) => (c.error ? 'Request failed' : 'Request completed'),
    },
    pino: pino(
      {
        level: env.LOG_LEVEL ?? 'info',
      },
      env.NODE_ENV === 'production' ? undefined : pretty()
    ),
  });
}
