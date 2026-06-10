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

async function main() {
  const sql = postgres(bootstrapUrl!, { max: 1 });
  try {
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
