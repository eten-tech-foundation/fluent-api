/**
 * src/db/scripts/reset-db.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Destructive, manual-only clean-slate reset for the dev and qa environments.
 *
 * USAGE:
 *   npm run db:reset:dev    → resets the dev Azure DB
 *   npm run db:reset:qa     → resets the qa  Azure DB
 *
 * WHAT IT DOES:
 *   1. Prints the masked MIGRATIONS_DATABASE_URL and the database name.
 *   2. Requires the operator to type the exact database name to proceed —
 *      there is intentionally no --yes / --force flag.
 *   3. Drops the `public`, `drizzle`, and `pgboss` schemas CASCADE and
 *      recreates `public` (owner: api_migrator) and `pgboss` (owner:
 *      api_user). The `ai` schema belongs to the AI service and is NEVER
 *      touched. `drizzle` is not recreated — drizzle-kit migrate does that
 *      itself during the setup run.
 *   4. Delegates to setup.ts so migrations + all seeds re-run unchanged.
 *
 * Connects via MIGRATIONS_DATABASE_URL (the DDL-capable api_migrator role),
 * NOT the runtime DATABASE_URL — api_user must never get DDL rights.
 *
 * NOT for local Docker — use `docker compose down -v` (or ./fapi.sh clean).
 */
// Load .env for local convenience — dotenv never overwrites real env vars,
// so shell / CI / Azure App Config values always win.
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import postgres from 'postgres';

import type { EnvConfig } from '@/db/env-configs/types';
import type { Sql } from '@/db/scripts/sql-helpers';

import { databaseNameFromUrl, maskDatabaseUrl } from '@/db/env-configs/database-url';
import { ident } from '@/db/scripts/sql-helpers';

const RESETTABLE_ENVS = ['dev', 'qa'] as const;

/** Schemas dropped on reset. `ai` is deliberately absent — AI service data. */
const SCHEMAS_TO_DROP = ['public', 'drizzle', 'pgboss'] as const;

async function resetSchemas(sql: Sql): Promise<void> {
  const apiUser = await ident(sql, 'api_user');
  const apiMigrator = await ident(sql, 'api_migrator');
  const schemaIdents = Object.fromEntries(
    await Promise.all(SCHEMAS_TO_DROP.map(async (s) => [s, await ident(sql, s)]))
  );

  for (const schema of SCHEMAS_TO_DROP) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schemaIdents[schema]} CASCADE`);
    console.log(`  Dropped schema ${schema} (CASCADE).`);
  }

  const publicSchema = schemaIdents.public;
  const pgbossSchema = schemaIdents.pgboss;

  // Ownership mirrors provision-db.ts: public → api_migrator (DDL),
  // pgboss → api_user (pg-boss manages its own objects at runtime).
  // Requires api_migrator to hold `GRANT api_user TO api_migrator` from
  // provision-db.ts — needed to DROP the api_user-owned pgboss schema and
  // to AUTHORIZATION it back to api_user here.
  await sql.unsafe(`CREATE SCHEMA ${publicSchema} AUTHORIZATION ${apiMigrator}`);
  await sql.unsafe(`CREATE SCHEMA ${pgbossSchema} AUTHORIZATION ${apiUser}`);
  // Dropping public removes the stock USAGE grant — api_user needs it for DML.
  await sql.unsafe(`GRANT USAGE ON SCHEMA ${publicSchema} TO ${apiUser}`);
  console.log('  Recreated public (owner: api_migrator) and pgboss (owner: api_user).');

  // The schema drop also destroys provision-db.ts's default-privilege rules
  // (pg_default_acl rows are schema-scoped). Re-establish them BEFORE
  // migrations run so every table api_migrator creates still grants api_user
  // DML — otherwise the runtime role can't read the tables it just seeded.
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${apiMigrator} IN SCHEMA ${publicSchema} ` +
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${apiUser}`
  );
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${apiMigrator} IN SCHEMA ${publicSchema} ` +
      `GRANT USAGE, SELECT ON SEQUENCES TO ${apiUser}`
  );
  console.log('  Restored api_migrator → api_user default privileges on public.');
}

async function main() {
  // ── 1. Environment gate — dev/qa only ───────────────────────────────────
  const envName = process.env.SETUP_ENV ?? '';
  if (!RESETTABLE_ENVS.includes(envName as (typeof RESETTABLE_ENVS)[number])) {
    console.error(
      `❌  db:reset only supports SETUP_ENV=dev|qa (got "${envName || '<unset>'}").\n` +
        '   For local Docker, reset the volume instead: `docker compose down -v` (or ./fapi.sh clean).'
    );
    process.exit(1);
  }

  const mod = (await import(`@/db/env-configs/${envName}`)) as { config: EnvConfig };
  const config = mod.config;

  // ── 2. Require the DDL-capable connection ───────────────────────────────
  const migrationsUrl = process.env.MIGRATIONS_DATABASE_URL;
  if (!migrationsUrl) {
    console.error(
      '❌  MIGRATIONS_DATABASE_URL is required for db:reset.\n' +
        '   Set it to the api_migrator (DDL-capable) connection string in your environment or .env file.'
    );
    process.exit(1);
  }

  const dbName = databaseNameFromUrl(migrationsUrl);

  // ── 3. Destructive confirmation — exact database name required ──────────
  console.log(`\n⚠️  DESTRUCTIVE DATABASE RESET — ${config.label}\n`);
  console.log(`Target URL     : ${maskDatabaseUrl(migrationsUrl)}`);
  console.log(`Database       : ${dbName}`);
  console.log('\nThis will DROP the public, drizzle, and pgboss schemas (CASCADE),');
  console.log('recreate public + pgboss, and re-run migrations + all seeds.');
  console.log('The ai schema is not touched.');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nType the database name "${dbName}" to confirm: `);
  rl.close();

  if (answer.trim() !== dbName) {
    console.error('\nAborted — database name did not match. No changes made.');
    process.exit(1);
  }

  // ── 4. Drop + recreate application schemas ──────────────────────────────
  console.log('\nResetting schemas...');
  const sql = postgres(migrationsUrl, { max: 1 });
  try {
    await sql`SELECT 1`;
    await resetSchemas(sql);
  } finally {
    await sql.end();
  }
  console.log('Schemas reset.\n');

  // ── 5. Delegate to the standard setup pipeline ──────────────────────────
  console.log('Running full setup (migrations + seeds)...\n');
  execSync('npx tsx src/db/scripts/setup.ts', {
    stdio: 'inherit',
    env: { ...process.env, SETUP_ENV: envName },
  });

  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║        DB reset + setup complete ✓     ║');
  console.log('╚═══════════════════════════════════════╝\n');
}

main().catch((err: unknown) => {
  console.error('db:reset failed:', err);
  process.exit(1);
});
