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
 *   creates the full role hierarchy used in production-grade environments:
 *
 *   Group roles (no LOGIN):
 *     role_web_data      — full DML on the public schema
 *     role_ai_data       — full DML on the ai schema
 *     role_ai_reader     — SELECT-only on public (cross-schema reads for AI)
 *     role_pgboss_user   — full DML on the pgboss schema
 *     role_migrations    — DDL + DML across all schemas
 *
 *   Login users:
 *     db_admin     (CREATEROLE, owns all schemas)
 *     migrations   → role_migrations
 *     web_user     → role_web_data + role_pgboss_user
 *     ai_user      → role_ai_data + role_ai_reader + role_pgboss_user
 *
 *   Schemas created / owned:
 *     public, ai, pgboss, drizzle  (all owned by db_admin)
 *
 * IDEMPOTENT:
 *   Safe to re-run — roles are created or altered, never dropped.
 *
 * NOTE:
 *   This script is NOT called by docker-entrypoint.sh or db:setup.
 *   It is a one-time provisioning step that must be run before db:setup on a
 *   fresh Azure Flexible Server.  Local docker uses bootstrap.ts instead.
 */
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

/** CREATE or ALTER a role with LOGIN and a password. Idempotent. */
async function upsertLoginRole(sql: Sql, roleName: string, password: string, extraOptions = '') {
  const roleIdent = await ident(sql, roleName);
  const pwLiteral = await literal(sql, password);
  const [row] =
    await sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleName}) AS exists`;
  const verb = row.exists ? 'ALTER' : 'CREATE';
  await sql.unsafe(`${verb} ROLE ${roleIdent} LOGIN PASSWORD ${pwLiteral} ${extraOptions}`.trim());
  console.log(`  ${verb} ROLE ${roleName} (login)`);
}

/** CREATE a group role (no LOGIN) if it doesn't exist. Idempotent. */
async function ensureGroupRole(sql: Sql, roleName: string) {
  const roleIdent = await ident(sql, roleName);
  const [row] =
    await sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleName}) AS exists`;
  if (!row.exists) {
    await sql.unsafe(`CREATE ROLE ${roleIdent}`);
    console.log(`  CREATE ROLE ${roleName} (group)`);
  } else {
    console.log(`  ROLE ${roleName} already exists — skipped`);
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

    const dbIdent = await ident(sql, dbName);

    // ── 1. Group roles (no LOGIN) ──────────────────────────────────────────
    console.log('\n[1/6] Creating group roles...');
    for (const role of [
      'role_web_data',
      'role_ai_data',
      'role_ai_reader',
      'role_pgboss_user',
      'role_migrations',
    ]) {
      await ensureGroupRole(sql, role);
    }

    // ── 2. Login users ──────────────────────────────────────────────────────
    console.log('\n[2/6] Creating login users...');
    await upsertLoginRole(sql, 'db_admin', cfg.dbAdminPassword, 'CREATEROLE');
    await upsertLoginRole(sql, 'migrations', cfg.migrationsPassword);
    await upsertLoginRole(sql, 'web_user', cfg.webUserPassword);
    await upsertLoginRole(sql, 'ai_user', cfg.aiUserPassword);

    // ── 3. Role membership ─────────────────────────────────────────────────
    console.log('\n[3/6] Granting group roles to login users...');
    await grantRole(sql, 'role_web_data', 'web_user');
    await grantRole(sql, 'role_pgboss_user', 'web_user');
    await grantRole(sql, 'role_ai_data', 'ai_user');
    await grantRole(sql, 'role_ai_reader', 'ai_user');
    await grantRole(sql, 'role_pgboss_user', 'ai_user');
    await grantRole(sql, 'role_migrations', 'migrations');
    console.log('  Done.');

    // ── 4. Schemas ─────────────────────────────────────────────────────────
    console.log('\n[4/6] Creating schemas and transferring ownership to db_admin...');
    const dbAdmin = await ident(sql, 'db_admin');
    for (const schema of ['public', 'ai', 'pgboss', 'drizzle']) {
      const s = await ident(sql, schema);
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${s}`);
      await sql.unsafe(`ALTER SCHEMA ${s} OWNER TO ${dbAdmin}`);
      console.log(`  Schema ${schema} — owner: db_admin`);
    }

    // ── 5. Schema-level grants ──────────────────────────────────────────────
    console.log('\n[5/6] Applying schema usage grants...');

    const roleWebData = await ident(sql, 'role_web_data');
    const roleAiData = await ident(sql, 'role_ai_data');
    const roleAiReader = await ident(sql, 'role_ai_reader');
    const rolePgbossUser = await ident(sql, 'role_pgboss_user');
    const roleMigrations = await ident(sql, 'role_migrations');

    // role_web_data: full DML on public
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleWebData}`);
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleWebData}`
    );
    await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleWebData}`);

    // role_ai_data: full DML on ai
    await sql.unsafe(`GRANT USAGE ON SCHEMA ai TO ${roleAiData}`);
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai TO ${roleAiData}`
    );
    await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ai TO ${roleAiData}`);

    // role_ai_reader: SELECT on public (cross-schema reads)
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleAiReader}`);
    await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${roleAiReader}`);

    // role_pgboss_user: full DML on pgboss
    await sql.unsafe(`GRANT USAGE ON SCHEMA pgboss TO ${rolePgbossUser}`);
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${rolePgbossUser}`
    );
    await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO ${rolePgbossUser}`);

    // role_migrations: DDL + DML across all schemas
    for (const schema of ['public', 'ai', 'pgboss', 'drizzle']) {
      const s = await ident(sql, schema);
      await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA ${s} TO ${roleMigrations}`);
      await sql.unsafe(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${s} TO ${roleMigrations}`);
      await sql.unsafe(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${s} TO ${roleMigrations}`);
    }

    // db_admin also needs CONNECT on the database itself
    await sql.unsafe(`GRANT CONNECT ON DATABASE ${dbIdent} TO ${dbAdmin}`);

    console.log('  Done.');

    // ── 6. Default privileges (for future tables created by db_admin) ───────
    console.log('\n[6/6] Setting default privileges for future objects...');

    // public schema
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${dbAdmin} IN SCHEMA public ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleWebData}`
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${dbAdmin} IN SCHEMA public ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${roleWebData}`
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${dbAdmin} IN SCHEMA public ` +
        `GRANT SELECT ON TABLES TO ${roleAiReader}`
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${dbAdmin} IN SCHEMA public ` +
        `GRANT ALL PRIVILEGES ON TABLES TO ${roleMigrations}`
    );

    // ai schema
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${dbAdmin} IN SCHEMA ai ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleAiData}`
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${dbAdmin} IN SCHEMA ai ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${roleAiData}`
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${dbAdmin} IN SCHEMA ai ` +
        `GRANT ALL PRIVILEGES ON TABLES TO ${roleMigrations}`
    );

    // pgboss schema
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${dbAdmin} IN SCHEMA pgboss ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${rolePgbossUser}`
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${dbAdmin} IN SCHEMA pgboss ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${rolePgbossUser}`
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${dbAdmin} IN SCHEMA pgboss ` +
        `GRANT ALL PRIVILEGES ON TABLES TO ${roleMigrations}`
    );

    // drizzle schema
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${dbAdmin} IN SCHEMA drizzle ` +
        `GRANT ALL PRIVILEGES ON TABLES TO ${roleMigrations}`
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

  const provisionConfig = {
    bootstrapDatabaseUrl,
    dbAdminPassword: process.env.DB_ADMIN_PASSWORD || config.provision?.dbAdminPassword || '',
    migrationsPassword:
      process.env.MIGRATIONS_PASSWORD || config.provision?.migrationsPassword || '',
    webUserPassword: process.env.WEB_USER_PASSWORD || config.provision?.webUserPassword || '',
    aiUserPassword: process.env.AI_USER_PASSWORD || config.provision?.aiUserPassword || '',
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
