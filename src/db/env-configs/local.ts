/**
 * env-configs/local.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Configuration for local Docker development.
 *
 * DATABASE_URL is NOT set here — it is injected by docker-compose via the
 * `environment:` block in compose.yaml, so the container already has it.
 *
 * Credentials are intentionally plain / local-only defaults.
 * Three seed users are created so a developer can exercise all role flows
 * immediately without manual setup.
 */
import { devSpec } from '@/db/seeds/demo/dev-spec';

import type { EnvConfig } from './types';

export const config: EnvConfig = {
  label: 'Local Docker',
  orgName: 'Fluent Dev',

  // No databaseUrl here — compose.yaml injects DATABASE_URL into the container.

  demoSpec: devSpec({
    pm: { email: 'pm@fluent.local', username: 'devpm', password: 'pm@123456' },
    translators: [
      { email: 't@fluent.local', username: 'translator', password: 't@123456' },
      { email: 't2@fluent.local', username: 'translator2', password: 't@123456' },
    ],
  }),

  printCredentials: true,
};
