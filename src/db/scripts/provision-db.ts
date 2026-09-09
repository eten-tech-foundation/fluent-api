/**
 * src/db/scripts/provision-db.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time DB-level role provisioning for dev and qa environments.
 *
 * USAGE:
 *   npm run db:provision:dev     → provisions roles on the dev Azure DB
 *   npm run db:provision:qa      → provisions roles on the qa  Azure DB
 *
 * WHAT IT DOES:
 *   Connects as a superuser (bootstrapDatabaseUrl from the env-config) and
 *   creates the role hierarchy used in production-grade environments:
 *
 *   Login users:
 *     api_migrator (CREATE on database, owns public and drizzle schemas)
 *     api_user     (DML on public via default privileges from api_migrator; owns pgboss)
 *     ai_migrator  (owns ai schema)
 *     ai_user      (DML on ai via default privileges from ai_migrator)
 *
 *   Schemas created / owned:
 *     public, drizzle  (owned by api_migrator)
 *     ai               (owned by ai_migrator)
 *     pgboss           (owned by api_user — pg-boss manages its own objects)
 *
 * IDEMPOTENT:
 *   Safe to re-run — roles are created or altered, never dropped.
 *
 * NOTE:
 *   This script is NOT called by docker-entrypoint.sh or db:setup.
 *   It is a one-time provisioning step that must be run before db:setup on a
 *   fresh Azure Flexible Server. Local docker uses bootstrap.ts instead.
 *
 *   PGBOSS CONTRACT: This script creates the pgboss schema (step 3) as the
 *   bootstrap superuser and grants ownership to api_user. This is
 *   what allows queue.ts to run with createSchema: false — the runtime role
 *   (api_user) never needs CREATE ON DATABASE.
 *
 *   OWNERSHIP: Step 5 reassigns ownership of every existing table, sequence,
 *   view, and enum type in public/drizzle to `api_migrator`, and in ai to
 *   `ai_migrator`. GRANT (even ALL PRIVILEGES) never confers DDL rights on an
 *   existing object — ALTER/DROP requires being the owner — so without this,
 *   a migration that runs ALTER TABLE against an object created before this
 *   role split (or by some other admin login) fails with "must be owner of ...".
 */
// Load .env for local convenience — dotenv never overwrites real env vars,
// so shell / CI / Azure App Config values always win.
import 'dotenv/config';
import postgres from 'postgres';

import type { DbProvisionConfig, EnvConfig } from '@/db/env-configs/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Sql = postgres.Sql;

/** Returns a server-side-quoted identifier (safe against injection). */
async function ident(sql: Sql, name: string): Promise<string> {
  const [row] = await sql`SELECT quote_ident(${name}) AS q`;
  return row.q as string;
}

/** Returns a server-side-quoted string literal (safe against injection). */
async function literal(sql: Sql, value: string): Promise<string> {
  const [row] = await sql`SELECT quote_literal(${value}) AS q`;
  return row.q as string;
}

/** CREATE or ALTER a role with LOGIN, a specific password, and only the requested extra options.
 *  On ALTER, elevated attributes manageable by a CREATEROLE admin (CREATEDB, CREATEROLE) are
 *  explicitly cleared unless requested in extraOptions. Superuser attributes (SUPERUSER, REPLICATION,
 *  BYPASSRLS) are omitted so non-superuser admins (like Azure's azure_pg_admin) can re-run safely. Idempotent. */
async function upsertLoginRole(sql: Sql, roleName: string, password: string, extraOptions = '') {
  const roleIdent = await ident(sql, roleName);
  const pwLiteral = await literal(sql, password);
  const [row] =
    await sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleName}) AS exists`;
  if (row.exists) {
    // Reconcile: reset LOGIN, password, and clear CREATEDB / CREATEROLE unless requested in extraOptions.
    let clearAttrs = 'NOCREATEDB NOCREATEROLE';
    if (extraOptions.includes('CREATEROLE')) {
      clearAttrs = clearAttrs.replace('NOCREATEROLE', '');
    }
    if (extraOptions.includes('CREATEDB')) {
      clearAttrs = clearAttrs.replace('NOCREATEDB', '');
    }
    const attrsStr = `${clearAttrs} ${extraOptions}`.replace(/\s+/g, ' ').trim();
    await sql.unsafe(`ALTER ROLE ${roleIdent} LOGIN PASSWORD ${pwLiteral} ${attrsStr}`.trim());
    console.log(`  ALTER ROLE ${roleName} (login — attributes reconciled)`);
  } else {
    await sql.unsafe(`CREATE ROLE ${roleIdent} LOGIN PASSWORD ${pwLiteral} ${extraOptions}`.trim());
    console.log(`  CREATE ROLE ${roleName} (login)`);
  }
}

/** GRANT a group role to a login role (idempotent — Postgres ignores duplicate grants). */
async function grantRole(sql: Sql, groupRole: string, loginRole: string) {
  const g = await ident(sql, groupRole);
  const l = await ident(sql, loginRole);
  await sql.unsafe(`GRANT ${g} TO ${l}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function provision(cfg: DbProvisionConfig, _dbName: string) {
  const sql = postgres(cfg.bootstrapDatabaseUrl, { max: 1 });

  try {
    // Verify connectivity before doing any DDL.
    await sql`SELECT 1`;

    // ── 1. Login users ──────────────────────────────────────────────────────
    console.log('\n[1/5] Creating login users...');
    // Only API migrator needs CREATE on database for Drizzle
    await upsertLoginRole(sql, 'api_migrator', cfg.apiMigratorPassword, 'CREATEDB');
    await upsertLoginRole(sql, 'api_user', cfg.apiUserPassword);
    await upsertLoginRole(sql, 'ai_migrator', cfg.aiMigratorPassword);
    await upsertLoginRole(sql, 'ai_user', cfg.aiUserPassword);

    // Grant migrators to the connecting bootstrap user (e.g. azure_pg_admin)
    // so ALTER DEFAULT PRIVILEGES FOR ROLE <role> succeeds on non-superuser hosts (like Azure Flexible Server).
    const [currUserRow] = await sql`SELECT CURRENT_USER AS u`;
    const bootstrapUser = currUserRow.u as string;
    await grantRole(sql, 'api_migrator', bootstrapUser);
    await grantRole(sql, 'ai_migrator', bootstrapUser);
    console.log('  Done.');

    // ── 2. Schemas ─────────────────────────────────────────────────────────
    console.log('\n[2/5] Creating schemas and transferring ownership...');
    const apiMigrator = await ident(sql, 'api_migrator');
    const aiMigrator = await ident(sql, 'ai_migrator');
    const apiUser = await ident(sql, 'api_user');

    for (const schema of ['public', 'drizzle']) {
      const s = await ident(sql, schema);
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${s}`);
      await sql.unsafe(`ALTER SCHEMA ${s} OWNER TO ${apiMigrator}`);
      console.log(`  Schema ${schema} — owner: api_migrator`);
    }

    const aiS = await ident(sql, 'ai');
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${aiS}`);
    await sql.unsafe(`ALTER SCHEMA ${aiS} OWNER TO ${aiMigrator}`);
    console.log(`  Schema ai — owner: ai_migrator`);

    // pgboss is owned by api_user so pg-boss can manage
    // its own tables/enums/functions at runtime without needing CREATE ON DATABASE.
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION ${apiUser}`);
    console.log(`  Schema pgboss — owner: api_user`);

    // ── 3. Schema-level grants ──────────────────────────────────────────────
    console.log('\n[3/5] Applying schema usage grants...');

    const aiUser = await ident(sql, 'ai_user');

    // api_user: DML on public
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${apiUser}`);
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${apiUser}`
    );
    await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${apiUser}`);

    // ai_user: DML on ai (no access to public)
    await sql.unsafe(`GRANT USAGE ON SCHEMA ai TO ${aiUser}`);
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai TO ${aiUser}`
    );
    await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ai TO ${aiUser}`);

    // pgboss: api_user owns it, so it already has all rights on the schema.

    console.log('  Done.');

    // ── 4. Reassign ownership of pre-existing objects to migrators ──────────
    // This is required so Drizzle/Alembic can ALTER/DROP objects created
    // before the role separation.
    console.log('\n[4/5] Reassigning ownership of existing objects to migrators...');

    async function reassignSchemaObjects(schema: string, newOwner: string) {
      const s = await ident(sql, schema);
      const ownerIdent = await ident(sql, newOwner);

      const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = ${schema}`;
      for (const { tablename } of tables) {
        const t = await ident(sql, tablename as string);
        await sql.unsafe(`ALTER TABLE ${s}.${t} OWNER TO ${ownerIdent}`);
      }

      const sequences =
        await sql`SELECT sequencename FROM pg_sequences WHERE schemaname = ${schema}`;
      for (const { sequencename } of sequences) {
        const seq = await ident(sql, sequencename as string);
        await sql.unsafe(`ALTER SEQUENCE ${s}.${seq} OWNER TO ${ownerIdent}`);
      }

      const views = await sql`SELECT viewname FROM pg_views WHERE schemaname = ${schema}`;
      for (const { viewname } of views) {
        const v = await ident(sql, viewname as string);
        await sql.unsafe(`ALTER VIEW ${s}.${v} OWNER TO ${ownerIdent}`);
      }

      const types = await sql`
        SELECT t.typname
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = ${schema} AND t.typtype = 'e'
      `;
      for (const { typname } of types) {
        const ty = await ident(sql, typname as string);
        await sql.unsafe(`ALTER TYPE ${s}.${ty} OWNER TO ${ownerIdent}`);
      }
      console.log(`  Schema ${schema} — existing objects reassigned to ${newOwner}`);
    }

    await reassignSchemaObjects('public', 'api_migrator');
    await reassignSchemaObjects('drizzle', 'api_migrator');
    await reassignSchemaObjects('ai', 'ai_migrator');

    // ── 5. Default privileges (for future tables) ───────────────────────────
    console.log('\n[5/5] Setting default privileges for future objects...');

    // public schema (for tables created by api_migrator)
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${apiMigrator} IN SCHEMA public ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${apiUser}`
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${apiMigrator} IN SCHEMA public ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${apiUser}`
    );

    // ai schema (for tables created by ai_migrator)
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${aiMigrator} IN SCHEMA ai ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${aiUser}`
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${aiMigrator} IN SCHEMA ai ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${aiUser}`
    );

    console.log('  Done.');

    console.log('\n╔═══════════════════════════════════════╗');
    console.log('║       DB provisioning complete ✓       ║');
    console.log('╚═══════════════════════════════════════╝');
    console.log('\nNext step: run db:setup (or db:setup:dev / db:setup:qa) to seed data.\n');
  } finally {
    await sql.end();
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const envName = process.env.SETUP_ENV ?? 'dev';
  if (envName === 'local') {
    console.error(
      '❌  provision-db is not intended for the local environment.\n' +
        '   Local docker uses bootstrap.ts instead (run via docker-entrypoint.sh).'
    );
    process.exit(1);
  }

  // Dynamic import of the env-config (same pattern as setup.ts)
  const mod = (await import(`@/db/env-configs/${envName}`)) as { config: EnvConfig };
  const config = mod.config;

  const bootstrapDatabaseUrl =
    process.env.BOOTSTRAP_DATABASE_URL || config.provision?.bootstrapDatabaseUrl;

  if (!bootstrapDatabaseUrl) {
    console.error(
      `❌  No BOOTSTRAP_DATABASE_URL provided for environment "${envName}".\n` +
        '   Set BOOTSTRAP_DATABASE_URL in your environment or .env file.'
    );
    process.exit(1);
  }

  const required: Record<string, string | undefined> = {
    API_MIGRATOR_PASSWORD:
      process.env.API_MIGRATOR_PASSWORD || config.provision?.apiMigratorPassword,
    API_USER_PASSWORD: process.env.API_USER_PASSWORD || config.provision?.apiUserPassword,
    AI_MIGRATOR_PASSWORD: process.env.AI_MIGRATOR_PASSWORD || config.provision?.aiMigratorPassword,
    AI_USER_PASSWORD: process.env.AI_USER_PASSWORD || config.provision?.aiUserPassword,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error(
      `❌  Missing required password variable(s) for environment "${envName}":\n${missing.map((k) => `   • ${k}`).join('\n')}\n   Set them in your environment or .env file before provisioning.`
    );
    process.exit(1);
  }

  const provisionConfig = {
    bootstrapDatabaseUrl,
    apiMigratorPassword: required.API_MIGRATOR_PASSWORD!,
    apiUserPassword: required.API_USER_PASSWORD!,
    aiMigratorPassword: required.AI_MIGRATOR_PASSWORD!,
    aiUserPassword: required.AI_USER_PASSWORD!,
  };

  // Derive the database name from the bootstrapDatabaseUrl
  const url = new URL(provisionConfig.bootstrapDatabaseUrl);
  const dbName = decodeURIComponent(url.pathname.slice(1));

  console.log('╔═══════════════════════════════════════╗');
  console.log(`║  Fluent DB Provision — ${config.label.padEnd(15)}║`);
  console.log('╚═══════════════════════════════════════╝');
  console.log(`\nTarget database : ${dbName}`);
  const masked = provisionConfig.bootstrapDatabaseUrl.replace(/:([^@]+)@/, ':****@');
  console.log(`Bootstrap URL   : ${masked}\n`);

  await provision(provisionConfig, dbName);
}

main().catch((err: unknown) => {
  console.error('provision-db failed:', err);
  process.exit(1);
});
