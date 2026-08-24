/**
 * env-configs/qa.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Configuration for the QA / Staging environment (Azure Flexible Server).
 * Mirrors production quality — only a single Project Manager is seeded.
 *
 * HOW TO USE:
 *   npm run db:setup:qa            ← runs setup.ts with SETUP_ENV=qa
 *   npm run db:provision:qa        ← runs provision-db.ts with SETUP_ENV=qa
 *
 * DB URLS:
 *   Fill in the actual Azure connection strings below.
 *   The `databaseUrl` is used by `setup.ts` (Drizzle ORM / seeds).
 *   The `provision.bootstrapDatabaseUrl` is used by `provision-db.ts`
 *   (superuser — needed to create roles and set schema ownership).
 */
import type { EnvConfig } from './types';

export const config: EnvConfig = {
  label: 'QA / Staging',
  orgName: 'Fluent QA',

  // ── Application DB URL (runtime user, used by setup.ts) ──────────────────
  // Reads QA_DATABASE_URL or DATABASE_URL from environment
  databaseUrl: process.env.QA_DATABASE_URL ?? process.env.DATABASE_URL,

  seedUsers: [
    {
      email: process.env.QA_PM_EMAIL ?? 'pm@qa.fluent.bible',
      password: process.env.QA_PM_PASSWORD ?? 'CHANGE_ME_QA_PM_PW',
      username: 'qapm',
      role: 'project_manager',
    },
  ],

  // Avoid printing passwords to CI / staging logs.
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
