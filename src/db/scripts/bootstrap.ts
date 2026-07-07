// src/db/scripts/bootstrap.ts
// Idempotent DB provisioning for the API's own concern.
// Connects as the postgres superuser (BOOTSTRAP_DATABASE_URL) and creates the
// API's migration + runtime roles, its schemas, ownership, and default grants.
// Runs identically against a standalone or platform-shared Postgres.
//
// Identifiers and the password literal are quoted server-side via
// quote_ident() / quote_literal(), so role names, the database name, and
// passwords containing special characters cannot break or inject the DDL.
import postgres from 'postgres';

interface Conn {
  user: string;
  password: string;
  database: string;
}

function parseConn(url: string): Conn {
  const u = new URL(url);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
}

const bootstrapUrl = process.env.BOOTSTRAP_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
const migrationsUrl = process.env.MIGRATIONS_DATABASE_URL;

if (!bootstrapUrl || !runtimeUrl || !migrationsUrl) {
  throw new Error(
    'bootstrap requires BOOTSTRAP_DATABASE_URL, DATABASE_URL, MIGRATIONS_DATABASE_URL'
  );
}

const runtime = parseConn(runtimeUrl);
const migrator = parseConn(migrationsUrl);
const database = parseConn(bootstrapUrl).database;

if (runtime.database !== database || migrator.database !== database) {
  throw new Error(
    `all three DATABASE URLs must reference the same database ` +
      `(bootstrap=${database}, runtime=${runtime.database}, migrations=${migrator.database})`
  );
}

/**
 * Transient errors seen while Postgres is up-but-not-ready. `pg_isready` (the
 * compose healthcheck) reports success as soon as the postmaster accepts
 * connections, but during startup/WAL-recovery the server still rejects real
 * queries with `57P03` ("the database system is starting up"). On a restart the
 * API therefore wins the race, fires its first bootstrap query, and dies. These
 * are retryable — the DB just needs a moment — so we poll until a trivial query
 * succeeds instead of crashing the container (and taking its dependents down).
 */
const TRANSIENT_STARTUP_CODES = new Set([
  '57P03', // cannot_connect_now — the database system is starting up
  '57P02', // crash_shutdown_in_progress
  '57P01', // admin_shutdown / terminating connection
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
]);

/** Node/socket-level errors that mean "DB not accepting connections yet". */
const TRANSIENT_SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND', // DNS for the `db` service name may not resolve at first
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return (
    typeof code === 'string' &&
    (TRANSIENT_STARTUP_CODES.has(code) || TRANSIENT_SOCKET_CODES.has(code))
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the database actually answers a query (not just accepts a socket),
 * so bootstrap runs against a server that is past its startup phase. Retries
 * only transient startup/connection errors; a real error (bad credentials, etc.)
 * fails fast. Bounded so a genuinely-down DB still surfaces after ~1 minute.
 */
async function waitForDatabase(sql: postgres.Sql): Promise<void> {
  const maxAttempts = 30;
  const delayMs = 2000; // ~60s total ceiling
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sql`SELECT 1`;
      if (attempt > 1) {
        console.log(`Database ready after ${attempt} attempt(s).`);
      }
      return;
    } catch (err) {
      if (!isTransientDbError(err) || attempt === maxAttempts) throw err;
      const code = (err as { code?: string }).code;
      console.log(
        `Database not ready yet (attempt ${attempt}/${maxAttempts}, ${code}); ` +
          `retrying in ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }
}

async function main() {
  const sql = postgres(bootstrapUrl!, { max: 1 });
  try {
    // The compose healthcheck (pg_isready) can report "ready" while Postgres is
    // still starting up and rejecting queries with 57P03; wait for a real query
    // to succeed before issuing any DDL, so a restart doesn't lose the race.
    await waitForDatabase(sql);

    // Ask Postgres to produce safe identifier / literal text so special
    // characters in role names, the db name, or passwords cannot break the DDL.
    const ident = async (name: string): Promise<string> => {
      const [row] = await sql`SELECT quote_ident(${name}) AS q`;
      return row.q as string;
    };
    const literal = async (value: string): Promise<string> => {
      const [row] = await sql`SELECT quote_literal(${value}) AS q`;
      return row.q as string;
    };

    // Roles (CREATE ROLE has no IF NOT EXISTS — check, then create or alter).
    for (const role of [migrator, runtime]) {
      const roleIdent = await ident(role.user);
      const pwLiteral = await literal(role.password);
      const [row] =
        await sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role.user}) AS exists`;
      const verb = row.exists ? 'ALTER' : 'CREATE';
      await sql.unsafe(`${verb} ROLE ${roleIdent} LOGIN PASSWORD ${pwLiteral}`);
    }

    const migratorIdent = await ident(migrator.user);
    const runtimeIdent = await ident(runtime.user);
    const dbIdent = await ident(database);

    // Migrator owns DDL surfaces; allow it to create the drizzle tracking schema.
    await sql.unsafe(`ALTER SCHEMA public OWNER TO ${migratorIdent}`);
    await sql.unsafe(`GRANT CREATE ON DATABASE ${dbIdent} TO ${migratorIdent}`);

    // pgboss is API-internal; runtime role owns it so pg-boss can manage it.
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION ${runtimeIdent}`);

    // Runtime role can use public and gets DML on everything the migrator creates there.
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtimeIdent}`);
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorIdent} IN SCHEMA public ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeIdent}`
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorIdent} IN SCHEMA public ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${runtimeIdent}`
    );
    // Cover any tables already present from a prior migrate in this volume.
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeIdent}`
    );
    await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtimeIdent}`);

    console.log('API bootstrap complete: roles, schemas, grants ensured.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('API bootstrap failed:', err);
  process.exit(1);
});
