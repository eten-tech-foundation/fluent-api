import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';
import { z } from 'zod';

import env from '@/env';
import { buildFeatures, featuresSchema } from '@/lib/features';
import { authenticateUser } from '@/middlewares/role-auth';
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
  // Login-gated (no role) — matches the /self/settings pattern: authenticateUser
  // turns a missing session into a 401 (the global passive `authenticate` in
  // server.ts populates c.get('user') first). Reviewer-confirmed for #211 Q1
  // (kaseywright, 2026-07-07): keep the read behind auth, reversible later.
  middleware: [authenticateUser] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      featuresResponseSchema,
      'The set of optional features that are enabled in this environment'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
  },
  summary: 'Published feature flags',
  description:
    'Returns the env-derived map of which optional features are enabled in this ' +
    'environment. Requires an authenticated session (login-gated, no role) and is ' +
    'read-only: it publishes state, it does not enforce it — the publish-vs-enforce ' +
    'decoupling (D5) is unchanged; only the read is now login-gated (#211 Q1).',
});

server.openapi(configFeaturesRoute, (c) => {
  return c.json({ features: buildFeatures(env) }, HttpStatusCodes.OK);
});

export default server;
