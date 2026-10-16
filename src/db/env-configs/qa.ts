/**
 * env-configs/qa.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Configuration for the QA / Staging environment (Azure Flexible Server).
 * Seeds the full deterministic demo world — 4 orgs, 18 users, 3 projects —
 * where every account shares one committed password hash (`qaSpec`).
 *
 * HOW TO USE:
 *   npm run db:setup:qa            ← runs setup.ts with SETUP_ENV=qa
 *   npm run db:provision:qa        ← runs provision-db.ts with SETUP_ENV=qa
 *   npm run db:seed:demo:qa        ← runs only the demo seed stage
 *
 * DB URLS:
 *   Fill in the actual Azure connection strings below.
 *   The `databaseUrl` is used by `setup.ts` (Drizzle ORM / seeds).
 *   The `provision.bootstrapDatabaseUrl` is used by `provision-db.ts`
 *   (superuser — needed to create roles and set schema ownership).
 */
import { qaSpec } from '@/db/seeds/demo/qa-spec';

import type { EnvConfig } from './types';

export const config: EnvConfig = {
  label: 'QA / Staging',
  orgName: 'Fluent QA',

  // ── Application DB URLs (used by setup.ts) ──────────────────────────
  // QA_DATABASE_URL wins; DATABASE_URL is a last resort fallback.
  // setup.ts will error if neither is set.
  databaseUrl: process.env.QA_DATABASE_URL ?? process.env.DATABASE_URL,

  // The whole QA world comes from the committed demo spec — no env-var
  // credentials, no post-seed password steps.
  demoSpec: qaSpec,

  // Avoid printing credentials to CI / staging logs.
  printCredentials: false,

  // ── DB-level provisioning (used by provision-db.ts only) ─────────────────
  provision: {
    bootstrapDatabaseUrl: process.env.BOOTSTRAP_DATABASE_URL ?? '',
    apiMigratorPassword: process.env.API_MIGRATOR_PASSWORD ?? '',
    apiUserPassword: process.env.API_USER_PASSWORD ?? '',
    aiMigratorPassword: process.env.AI_MIGRATOR_PASSWORD ?? '',
    aiUserPassword: process.env.AI_USER_PASSWORD ?? '',
  },
};
