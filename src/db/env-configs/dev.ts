/**
 * env-configs/dev.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Configuration for the shared Dev environment (Azure Flexible Server).
 *
 * HOW TO USE:
 *   npm run db:setup:dev           ← runs setup.ts with SETUP_ENV=dev
 *   npm run db:provision:dev       ← runs provision-db.ts with SETUP_ENV=dev
 *
 * CREDENTIALS:
 *   Only a single Project Manager is seeded. All other users should be created
 *   through the application UI after first login, so they have proper audit
 *   trails and realistic profile data.
 *
 * DB URLS:
 *   Fill in the actual Azure connection strings below.
 *   The `databaseUrl` is used by `setup.ts` (Drizzle ORM / seeds).
 *   The `provision.bootstrapDatabaseUrl` is used by `provision-db.ts`
 *   (superuser — needed to create roles and set schema ownership).
 */
import type { EnvConfig } from './types';

export const config: EnvConfig = {
  label: 'Dev',
  orgName: 'Fluent Dev',

  // ── Application DB URL (runtime user, used by setup.ts) ──────────────────
  // Reads DEV_DATABASE_URL or DATABASE_URL from environment
  databaseUrl: process.env.DEV_DATABASE_URL ?? process.env.DATABASE_URL,

  seedUsers: [
    {
      email: 'qa.manager@fluent.com',
      password: 'Test@1234',
      username: 'qa.manager',
      role: 'project_manager',
    },
    {
      email: 'alice.smith@orga.com',
      password: 'Test@1234',
      username: 'alice.smith',
      role: 'project_translator',
    },
    {
      email: 'bob.johnson@orga.com',
      password: 'Test@1234',
      username: 'bob.johnson',
      role: 'project_translator',
    },
    {
      email: 'carol.davis@orga.com',
      password: 'Test@1234',
      username: 'carol.davis',
      role: 'project_translator',
    },
  ],

  // Avoid printing seed credentials to shared Dev server logs.
  printCredentials: false,

  // ── DB-level provisioning (used by provision-db.ts only) ─────────────────
  provision: {
    bootstrapDatabaseUrl: process.env.BOOTSTRAP_DATABASE_URL ?? '',
    dbAdminPassword: process.env.DB_ADMIN_PASSWORD ?? '',
    migrationsPassword: process.env.MIGRATIONS_PASSWORD ?? '',
    webUserPassword: process.env.WEB_USER_PASSWORD ?? '',
    aiUserPassword: process.env.AI_USER_PASSWORD ?? '',
  },
};
