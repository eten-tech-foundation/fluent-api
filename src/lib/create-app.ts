import { OpenAPIHono } from '@hono/zod-openapi';
import { requestId } from 'hono/request-id';
import { notFound, onError, serveEmojiFavicon } from 'stoker/middlewares';
import { defaultHook } from 'stoker/openapi';

import { pinoLogger } from '@/middlewares/pino-logger';

import type { AppBindings } from './types';

function createRouter() {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook,
  });
}

export default function createApp() {
  const app = createRouter();
  // Always generate IDs locally: an inbound ID may contain sensitive user text.
  app
    .use(requestId({ limitLength: 0 }))
    .use(serveEmojiFavicon('📝'))
    .use(pinoLogger());

  app.notFound(notFound);
  app.onError(onError);
  return app;
}
