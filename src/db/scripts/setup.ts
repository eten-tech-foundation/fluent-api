/**
 * src/db/scripts/setup.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Environment-aware DB setup orchestrator.
 *
 * USAGE:
 *   npm run db:setup            → local docker (SETUP_ENV defaults to 'local')
 *   npm run db:setup:dev        → dev  (SETUP_ENV=dev)
 *   npm run db:setup:qa         → qa   (SETUP_ENV=qa)
 *
 * The script:
 *   1. Loads the env-config for the target environment.
 *   2. Optionally overrides DATABASE_URL from the config (dev / qa).
 *   3. Runs Drizzle migrations.
 *   4. Seeds all reference data (org, roles, RBAC, languages, books, bibles,
 *      bible texts, pericope sets) — identical across every environment.
 *   5. Seeds the configured seed users.
 *   6. Optionally prints credentials.
 *
 * All seed functions are dynamically imported AFTER the DATABASE_URL is set so
 * the Drizzle client picks up the correct connection string regardless of
 * which environment is targeted.
 */
// Load .env for local convenience — dotenv never overwrites real env vars,
// so shell / CI / Azure App Config values always win.
import 'dotenv/config';
import { execSync } from 'node:child_process';

import type { EnvConfig } from '@/db/env-configs/types';

// ─── 1. Resolve the target environment ───────────────────────────────────────

type EnvName = 'local' | 'dev' | 'qa';

const VALID_ENVS: readonly EnvName[] = ['local', 'dev', 'qa'];

function resolveEnvName(): EnvName {
  const raw = process.env.SETUP_ENV ?? 'local';
  if (!VALID_ENVS.includes(raw as EnvName)) {
    console.error(`❌  Unknown SETUP_ENV="${raw}". Valid values: ${VALID_ENVS.join(', ')}`);
    process.exit(1);
  }
  return raw as EnvName;
}

async function loadConfig(envName: EnvName): Promise<EnvConfig> {
  // Dynamic import — the path is derived from the env name, so TypeScript
  // can't statically analyse it; we cast the module type explicitly.
  const mod = (await import(`@/db/env-configs/${envName}`)) as { config: EnvConfig };
  return mod.config;
}

// ─── 2. Main ─────────────────────────────────────────────────────────────────

async function setup() {
  const envName = resolveEnvName();
  const config = await loadConfig(envName);

  console.log('╔═══════════════════════════════════════╗');
  console.log(`║   Fluent DB Setup — ${config.label.padEnd(17)}║`);
  console.log('╚═══════════════════════════════════════╝\n');

  // ── Resolve DATABASE_URL ──────────────────────────────────────────────────
  // The env-config owns URL resolution — DEV_DATABASE_URL / QA_DATABASE_URL
  // are already baked into config.databaseUrl by the env-config file, so we
  // just apply whatever the config provides. This ensures the env-specific URL
  // always wins and can never be silently overridden by a generic DATABASE_URL
  // that happens to be exported in the shell.
  if (config.databaseUrl) {
    process.env.DATABASE_URL = config.databaseUrl;
    const masked = config.databaseUrl.replace(/:([^@]+)@/, ':****@');
    console.log(`ℹ  DATABASE_URL → ${masked}\n`);
  } else if (!process.env.DATABASE_URL) {
    console.error(
      `❌  No database URL available for environment "${envName}".\n` +
        `   Set DEV_DATABASE_URL (for dev) or QA_DATABASE_URL (for qa) in your environment or .env file.`
    );
    process.exit(1);
  } else {
    // local: DATABASE_URL is injected by docker-compose; nothing to do.
    const masked = process.env.DATABASE_URL.replace(/:([^@]+)@/, ':****@');
    console.log(`ℹ  DATABASE_URL (from environment) → ${masked}\n`);
  }

  // ── Resolve MIGRATIONS_DATABASE_URL ───────────────────────────────────────
  // drizzle.config.ts prefers MIGRATIONS_DATABASE_URL over DATABASE_URL so
  // drizzle-kit migrate can run as the migrations role (DDL rights) rather
  // than web_user (DML only). For dev/qa, derive it from the same env-config
  // source if not already set.
  if (!process.env.MIGRATIONS_DATABASE_URL && config.migrationsUrl) {
    process.env.MIGRATIONS_DATABASE_URL = config.migrationsUrl;
    const masked = config.migrationsUrl.replace(/:([^@]+)@/, ':****@');
    console.log(`ℹ  MIGRATIONS_DATABASE_URL → ${masked}\n`);
  }

  // ── Migrations ────────────────────────────────────────────────────────────
  console.log('[1/9] Running migrations...');
  execSync('npx drizzle-kit migrate', {
    stdio: 'inherit',
    env: process.env,
  });
  console.log('Migrations complete.\n');

  // ── Dynamic seed imports (pick up the DATABASE_URL set above) ─────────────
  const [
    { seedOrganizations },
    { seedRoles },
    { seedRbac },
    { seedDevUsers },
    { seedLanguages },
    { seedBooks },
    { seedBibles },
    { seedBibleTexts },
    { seedPericopeSets },
  ] = await Promise.all([
    import('@/db/seeds/organizations'),
    import('@/db/seeds/roles'),
    import('@/db/seeds/rbac'),
    import('@/db/seeds/dev-users'),
    import('@/db/seeds/languages'),
    import('@/db/seeds/books'),
    import('@/db/seeds/bibles'),
    import('@/db/seeds/bible-texts'),
    import('@/db/seeds/pericope-sets'),
  ]);

  // ── Reference / system data (same for every environment) ──────────────────
  console.log('[2/9] Seeding organizations...');
  await seedOrganizations(config.orgName);
  console.log('');

  console.log('[3/9] Seeding roles...');
  await seedRoles();
  console.log('');

  console.log('[4/9] Seeding RBAC...');
  await seedRbac();
  console.log('');

  // ── Seed users (env-specific) ─────────────────────────────────────────────
  console.log(`[5/9] Seeding users (${config.seedUsers.length} configured)...`);
  await seedDevUsers(config.seedUsers, config.orgName);
  console.log('');

  // ── Bible reference data ───────────────────────────────────────────────────
  console.log('[6/9] Seeding languages...');
  await seedLanguages();
  console.log('');

  console.log('[7/9] Seeding books...');
  await seedBooks();
  console.log('');

  console.log('[8/9] Seeding bibles...');
  await seedBibles();
  console.log('');

  console.log('[9/9] Seeding bible texts and pericope sets...');
  await seedBibleTexts();
  await seedPericopeSets();
  console.log('');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('╔═══════════════════════════════════════╗');
  console.log('║           Setup complete ✓             ║');
  console.log('╚═══════════════════════════════════════╝\n');

  if (config.printCredentials && config.seedUsers.length > 0) {
    console.log('Seeded credentials:');
    for (const u of config.seedUsers) {
      console.log(`  [${u.role.padEnd(18)}]  ${u.email}  /  ${u.password}`);
    }
    console.log('');
  }

  process.exit(0);
}

setup().catch((err: unknown) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
