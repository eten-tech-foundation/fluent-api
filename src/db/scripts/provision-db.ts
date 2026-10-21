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
 *     api_migrator (GRANT CREATE ON DATABASE; owns public and drizzle schemas)
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
 *   Safe to re-run — roles are created or altered, never dropped. api_migrator
 *   gets CREATE ON DATABASE as an object privilege (GRANT), not the CREATEDB
 *   role attribute — CREATEDB would let it create whole new databases, far
 *   more than the "create the drizzle tracking schema" need it exists for.
 *
 * NOTE:
 *   This script is NOT called by docker-entrypoint.sh or db:setup.
 *   It is a one-time provisioning step that must be run before db:setup on a
 *   fresh Azure Flexible Server. Local docker uses bootstrap.ts instead.
 *
 *   PGBOSS CONTRACT: This script creates the pgboss schema (step 2) as the
 *   bootstrap superuser and grants ownership to api_user. This is
 *   what allows queue.ts to run with createSchema: false — the runtime role
 *   (api_user) never needs CREATE ON DATABASE. Ownership is set with both
 *   `AUTHORIZATION` (first creation) and an explicit `ALTER SCHEMA ... OWNER
 *   TO` (re-runs against a pre-existing pgboss schema, e.g. one still owned
 *   by the legacy web_user) — AUTHORIZATION alone is a no-op once the schema
 *   already exists.
 *
 *   OWNERSHIP: Step 4 reassigns ownership of every existing table, sequence,
 *   view, materialized view, enum type, function, and procedure in
 *   public/drizzle to `api_migrator`, in ai to `ai_migrator`, and in pgboss
 *   to `api_user`. GRANT (even ALL PRIVILEGES) never confers DDL rights on
 *   an existing object — ALTER/DROP requires being the owner — so without
 *   this, a migration that runs ALTER TABLE against an object created
 *   before this role split (or by some other admin login) fails with "must
 *   be owner of ...". pg-boss's own functions (create_queue, delete_queue,
 *   etc.) are exactly this case in the pgboss schema.
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

async function provision(cfg: DbProvisionConfig, dbName: string) {
  const sql = postgres(cfg.bootstrapDatabaseUrl, { max: 1 });

  try {
    // Verify connectivity before doing any DDL.
    await sql`SELECT 1`;

    // ── 1. Login users ──────────────────────────────────────────────────────
    console.log('\n[1/5] Creating login users...');
    await upsertLoginRole(sql, 'api_migrator', cfg.apiMigratorPassword);
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
    console.log('\n[2/5] Creating schemas, granting CREATE, and transferring ownership...');
    const apiMigrator = await ident(sql, 'api_migrator');
    const aiMigrator = await ident(sql, 'ai_migrator');
    const apiUser = await ident(sql, 'api_user');

    // api_migrator needs CREATE on the database itself (object privilege, not
    // the CREATEDB role attribute) so Drizzle's `CREATE SCHEMA IF NOT EXISTS
    // drizzle` check passes Postgres ACL checks.
    const dbIdent = await ident(sql, dbName);
    await sql.unsafe(`GRANT CREATE ON DATABASE ${dbIdent} TO ${apiMigrator}`);

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

    // pgboss is owned by api_user so pg-boss can manage its own
    // tables/enums/functions at runtime without needing CREATE ON DATABASE.
    // `AUTHORIZATION` only sets the owner on first creation, so on a database
    // that already has a pgboss schema (e.g. from the legacy model, still
    // owned by web_user) an explicit ALTER is needed too — otherwise this
    // step is silently a no-op on re-runs against an existing schema.
    const pgbossS = await ident(sql, 'pgboss');
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${pgbossS} AUTHORIZATION ${apiUser}`);
    await sql.unsafe(`ALTER SCHEMA ${pgbossS} OWNER TO ${apiUser}`);
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

      // pg_views excludes materialized views — handle them separately.
      const matviews = await sql`SELECT matviewname FROM pg_matviews WHERE schemaname = ${schema}`;
      for (const { matviewname } of matviews) {
        const mv = await ident(sql, matviewname as string);
        await sql.unsafe(`ALTER MATERIALIZED VIEW ${s}.${mv} OWNER TO ${ownerIdent}`);
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

      // pg_class/pg_tables/pg_views cover tables/sequences/views/matviews,
      // but functions and procedures live in pg_proc and are missed by all
      // of the above — e.g. pg-boss's own create_queue/delete_queue
      // functions, still owned by the legacy web_user. `oid::regprocedure`
      // renders each routine's fully schema- and argument-qualified
      // signature (from the catalog, not user input), which ALTER
      // FUNCTION/PROCEDURE needs to disambiguate overloads.
      const routines = await sql`
        SELECT p.oid::regprocedure::text AS signature, p.prokind
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${schema}
      `;
      for (const { signature, prokind } of routines) {
        const kind = prokind === 'p' ? 'PROCEDURE' : 'FUNCTION';
        await sql.unsafe(`ALTER ${kind} ${signature} OWNER TO ${ownerIdent}`);
      }

      console.log(`  Schema ${schema} — existing objects reassigned to ${newOwner}`);
    }

    await reassignSchemaObjects('public', 'api_migrator');
    await reassignSchemaObjects('drizzle', 'api_migrator');
    await reassignSchemaObjects('ai', 'ai_migrator');
    // pgboss objects too — on a database migrating from the legacy model,
    // pg-boss's own tables/enums may still be owned by the legacy web_user.
    await reassignSchemaObjects('pgboss', 'api_user');

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
