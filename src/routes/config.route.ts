import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';
import { z } from 'zod';

import env from '@/env';
import { buildFeatures, featuresSchema } from '@/lib/features';
import { server } from '@/server/server';

// The published feature map. `featuresSchema` (the programmer's catalog of named
// flags) lives with the FLAGS registry in src/lib/features.ts so the two stay
// tied by a compile-time `satisfies`; a flag is declared in THREE synced places
// — env.ts, the FLAGS registry, and featuresSchema — guarded by the drift test
// in src/lib/features.test.ts.
const featuresResponseSchema = z.object({
  features: featuresSchema,
});

const configFeaturesRoute = createRoute({
  tags: ['Config'],
  method: 'get',
  path: '/config/features',
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      featuresResponseSchema,
      'The set of optional features that are enabled in this environment'
    ),
  },
  summary: 'Published feature flags',
  description:
    'Returns the env-derived map of which optional features are enabled in this ' +
    'environment. Unauthenticated (like /health) and read-only: it publishes ' +
    'state, it does not enforce it.',
});

server.openapi(configFeaturesRoute, (c) => {
  return c.json({ features: buildFeatures(env) }, HttpStatusCodes.OK);
});

export default server;
