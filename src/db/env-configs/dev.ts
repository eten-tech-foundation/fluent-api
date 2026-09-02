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
 *   Set DEV_PM_EMAIL, DEV_PM_PASSWORD, and DEV_SEED_PASSWORD in your
 *   environment or .env file before running db:setup:dev.
 *   No hardcoded passwords — this server is network-reachable.
 *
 *   DEV_PM_EMAIL      — email for the seeded Project Manager account
 *   DEV_PM_PASSWORD   — password for the PM (unique, not shared)
 *   DEV_SEED_PASSWORD — shared password for the three translator accounts
 *                       (alice.smith, bob.johnson, carol.davis)
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

  // ── Application DB URLs (used by setup.ts) ──────────────────────────
  // DEV_DATABASE_URL wins; DATABASE_URL is a last resort fallback.
  // setup.ts will error if neither is set.
  databaseUrl: process.env.DEV_DATABASE_URL ?? process.env.DATABASE_URL,
  // For drizzle-kit migrate — runs as the DDL-capable migrations role.
  // Falls back to DATABASE_URL via drizzle.config.ts if unset.
  migrationsUrl: process.env.DEV_MIGRATIONS_DATABASE_URL,

  // Lazy getter — validation runs only when setup.ts accesses seedUsers.
  // provision-db.ts imports this config for provision.* credentials but never
  // reads seedUsers, so it can run cleanly without these vars being set.
  // Emails are hardcoded (obviously fake dev accounts). Passwords must be
  // provided via env — no committed credential for a network-reachable server.
  get seedUsers() {
    const pmEmail = process.env.DEV_PM_EMAIL;
    const pmPassword = process.env.DEV_PM_PASSWORD;
    const seedPassword = process.env.DEV_SEED_PASSWORD;
    if (!pmEmail) throw new Error('Missing required env var: DEV_PM_EMAIL');
    if (!pmPassword) throw new Error('Missing required env var: DEV_PM_PASSWORD');
    if (!seedPassword) throw new Error('Missing required env var: DEV_SEED_PASSWORD');
    return [
      { email: pmEmail, password: pmPassword, username: 'devpm', role: 'project_manager' as const },
      {
        email: 'alice.smith@orga.com',
        password: seedPassword,
        username: 'alice.smith',
        role: 'project_translator' as const,
      },
      {
        email: 'bob.johnson@orga.com',
        password: seedPassword,
        username: 'bob.johnson',
        role: 'project_translator' as const,
      },
      {
        email: 'carol.davis@orga.com',
        password: seedPassword,
        username: 'carol.davis',
        role: 'project_translator' as const,
      },
    ];
  },

  // Avoid printing passwords to shared Dev server logs.
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
