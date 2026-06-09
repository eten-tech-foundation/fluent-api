// src/db/scripts/bootstrap.ts
// Idempotent DB provisioning for the API's own concern.
// Connects as the postgres superuser (BOOTSTRAP_DATABASE_URL) and creates the
// API's migration + runtime roles, its schemas, ownership, and default grants.
// Runs identically against a standalone or platform-shared Postgres.
import postgres from 'postgres';

function parse(url: string): { user: string; password: string } {
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

const bootstrapUrl = process.env.BOOTSTRAP_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
const migrationsUrl = process.env.MIGRATIONS_DATABASE_URL;

if (!bootstrapUrl || !runtimeUrl || !migrationsUrl) {
  throw new Error('bootstrap requires BOOTSTRAP_DATABASE_URL, DATABASE_URL, MIGRATIONS_DATABASE_URL');
}

const runtime = parse(runtimeUrl);
const migrator = parse(migrationsUrl);

async function main() {
  const sql = postgres(bootstrapUrl, { max: 1 });
  try {
    // Roles (CREATE ROLE has no IF NOT EXISTS — guard with DO blocks).
    for (const role of [migrator, runtime]) {
      await sql.unsafe(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role.user}') THEN
            CREATE ROLE ${role.user} LOGIN PASSWORD '${role.password}';
          ELSE
            ALTER ROLE ${role.user} LOGIN PASSWORD '${role.password}';
          END IF;
        END $$;
      `);
    }

    // Migrator owns DDL surfaces; allow it to create the drizzle tracking schema.
    await sql.unsafe(`ALTER SCHEMA public OWNER TO ${migrator.user};`);
    await sql.unsafe(`GRANT CREATE ON DATABASE ${new URL(bootstrapUrl).pathname.slice(1)} TO ${migrator.user};`);

    // pgboss is API-internal; runtime role owns it so pg-boss can manage it.
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION ${runtime.user};`);

    // Runtime role can use public and gets DML on everything the migrator creates there.
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtime.user};`);
    await sql.unsafe(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator.user} IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime.user};
    `);
    await sql.unsafe(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator.user} IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO ${runtime.user};
    `);
    // Cover any tables already present from a prior migrate in this volume.
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime.user};`);
    await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime.user};`);

    console.log('API bootstrap complete: roles, schemas, grants ensured.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('API bootstrap failed:', err);
  process.exit(1);
});
