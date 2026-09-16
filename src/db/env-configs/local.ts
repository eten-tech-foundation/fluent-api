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
import type { EnvConfig } from './types';

export const config: EnvConfig = {
  label: 'Local Docker',
  orgName: 'Fluent Dev',

  // No databaseUrl here — compose.yaml injects DATABASE_URL into the container.

  seedUsers: [
    {
      email: 'pm@fluent.local',
      password: 'pm@123456',
      username: 'devpm',
      role: 'project_manager',
    },
    {
      email: 't@fluent.local',
      password: 't@123456',
      username: 'translator',
      role: 'project_translator',
    },
    {
      email: 't2@fluent.local',
      password: 't@123456',
      username: 'translator2',
      role: 'project_translator',
    },
  ],

  printCredentials: true,
};
