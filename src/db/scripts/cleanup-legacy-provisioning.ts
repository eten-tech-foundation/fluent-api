import 'dotenv/config';
import postgres from 'postgres';

import type { EnvConfig } from '@/db/env-configs/types';

async function ident(sql: postgres.Sql, name: string): Promise<string> {
  const [row] = await sql`SELECT quote_ident(${name}) AS q`;
  return row.q as string;
}

async function verifyOwnershipReassigned(sql: postgres.Sql) {
  console.log('\n[1/2] Verifying pre-conditions...');
  const schemas = ['public', 'ai', 'drizzle', 'pgboss'];
  let issues = 0;

  for (const schema of schemas) {
    const records = await sql`
      SELECT n.nspname as schema_name, r.rolname as owner 
      FROM pg_namespace n 
      JOIN pg_roles r ON n.nspowner = r.oid 
      WHERE n.nspname = ${schema} 
      AND r.rolname IN ('db_admin', 'migrations', 'web_user');
    `;

    if (records.length > 0) {
      console.error(
        `❌ Pre-condition failed: Schema ${schema} is still owned by legacy role ${records[0].owner}`
      );
      issues++;
    }
  }

  // check object ownership
  const query = await sql`
    SELECT n.nspname AS schema, c.relname AS object_name, r.rolname AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles r ON c.relowner = r.oid
    WHERE n.nspname IN ('public', 'ai', 'drizzle', 'pgboss')
    AND r.rolname IN ('db_admin', 'migrations', 'web_user');
  `;

  if (query.length > 0) {
    console.error('❌ Pre-condition failed: Found objects still owned by legacy roles:');
    for (const row of query) {
      console.error(`   - ${row.schema}.${row.object_name} (owned by ${row.owner})`);
    }
    issues++;
  }

  if (issues > 0) {
    console.error(
      '\nCannot proceed with cleanup. Run provision-db.ts first to reassign ownership.'
    );
    process.exit(1);
  }
  console.log('✓ All schema and object ownership has been properly reassigned.');
}

async function dropLegacyRoles(sql: postgres.Sql) {
  console.log('\n[2/2] Dropping legacy roles...');

  const rolesToDrop = [
    // Group roles first
    'role_web_data',
    'role_ai_data',
    'role_ai_reader',
    'role_pgboss_user',
    'role_migrations',
    // Login roles
    'db_admin',
    'migrations',
    'web_user',
  ];

  for (const role of rolesToDrop) {
    const roleIdent = await ident(sql, role);
    const [exists] =
      await sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS exists`;

    if (exists.exists) {
      try {
        console.log(`  Dropping objects owned by and privileges granted to ${role}...`);
        // We drop owned by first to clear default privileges and acl grants, WITHOUT CASCADE
        await sql.unsafe(`DROP OWNED BY ${roleIdent};`);

        console.log(`  Dropping role ${role}...`);
        await sql.unsafe(`DROP ROLE ${roleIdent};`);
        console.log(`  ✓ ${role} dropped.`);
      } catch (err: any) {
        console.error(`\n❌ Error dropping role ${role}: ${err.message}`);
        console.error(
          `This means something still depends on ${role} that was missed by provision-db.ts reassignment.`
        );
        console.error('Do not use CASCADE to bypass this. Investigate the dependency.\n');
        process.exit(1);
      }
    } else {
      console.log(`  - ${role} already dropped (does not exist).`);
    }
  }
  console.log('  Done.');
}

async function main() {
  const envName = process.env.SETUP_ENV ?? 'dev';
  if (envName === 'local') {
    console.error('❌ cleanup-legacy-provisioning is not intended for the local environment.');
    process.exit(1);
  }

  const mod = (await import(`@/db/env-configs/${envName}`)) as { config: EnvConfig };
  const config = mod.config;

  const bootstrapDatabaseUrl =
    process.env.BOOTSTRAP_DATABASE_URL || config.provision?.bootstrapDatabaseUrl;

  if (!bootstrapDatabaseUrl) {
    console.error(`❌ No BOOTSTRAP_DATABASE_URL provided for environment "${envName}".`);
    process.exit(1);
  }

  console.log('╔═══════════════════════════════════════╗');
  console.log(`║  Legacy DB Cleanup — ${config.label.padEnd(16)}║`);
  console.log('╚═══════════════════════════════════════╝');

  const sql = postgres(bootstrapDatabaseUrl, { max: 1 });

  try {
    await verifyOwnershipReassigned(sql);
    await dropLegacyRoles(sql);

    console.log('\n╔═══════════════════════════════════════╗');
    console.log('║       Legacy cleanup complete ✓        ║');
    console.log('╚═══════════════════════════════════════╝');
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error('cleanup-legacy-provisioning failed:', err);
  process.exit(1);
});
