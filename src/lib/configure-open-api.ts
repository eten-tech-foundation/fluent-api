import { Scalar } from '@scalar/hono-api-reference';

import type { AppOpenAPI } from './types';

import packageJSON from '../../package.json' with { type: 'json' };

export default function configureOpenAPI(app: AppOpenAPI) {
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Enter your session token here. You can get one by using the "Sign in with Email" endpoint.',
  });

  app.doc('/doc', {
    openapi: '3.0.0',
    info: {
      version: packageJSON.version,
      title: 'Fluent API',
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  });

  app.get('/doc-dynamic', async (c) => {
    const host = c.req.header('host')!;
    const proto = c.req.header('x-forwarded-proto') || 'http';
    const res = await fetch(`${proto}://${host}/doc`);
    const json = await res.json();
    json.servers = [{ url: `${proto}://${host}` }];
    return c.json(json);
  });

  app.get(
    '/reference',
    Scalar({
      theme: 'kepler',
      layout: 'classic',
      defaultHttpClient: {
        targetKey: 'js',
        clientKey: 'fetch',
      },
      url: '/doc-dynamic',
      authentication: {
        preferredSecurityScheme: 'bearerAuth',
      },
    })
  );
}
