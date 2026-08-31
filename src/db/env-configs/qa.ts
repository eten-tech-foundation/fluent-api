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

  // ── Application DB URLs (used by setup.ts) ──────────────────────────
  // QA_DATABASE_URL wins; DATABASE_URL is a last resort fallback.
  // setup.ts will error if neither is set.
  databaseUrl: process.env.QA_DATABASE_URL ?? process.env.DATABASE_URL,
  // For drizzle-kit migrate — runs as the DDL-capable migrations role.
  // Falls back to DATABASE_URL via drizzle.config.ts if unset.
  migrationsUrl: process.env.QA_MIGRATIONS_DATABASE_URL,

  // Lazy getter — validation runs only when setup.ts accesses seedUsers.
  // provision-db.ts imports this config for provision.* credentials but never
  // reads seedUsers, so it can run cleanly without QA_PM_EMAIL / QA_PM_PASSWORD.
  get seedUsers() {
    const email = process.env.QA_PM_EMAIL;
    const password = process.env.QA_PM_PASSWORD;
    if (!email) throw new Error('Missing required env var: QA_PM_EMAIL');
    if (!password) throw new Error('Missing required env var: QA_PM_PASSWORD');
    return [
      {
        email,
        password,
        username: 'qapm',
        role: 'project_manager' as const,
      },
    ];
  },

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
