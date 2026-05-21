import { execSync } from 'node:child_process';

import { seedDevUsers } from '@/db/seeds/dev-users';
import { seedOrganizations } from '@/db/seeds/organizations';
import { seedRbac } from '@/db/seeds/rbac';
import { seedRoles } from '@/db/seeds/roles';

async function setup() {
  console.log('=== Fluent DB Setup ===\n');

  console.log('[1/5] Running migrations...');
  execSync('npx drizzle-kit migrate', { stdio: 'inherit' });
  console.log('Migrations complete.\n');

  console.log('[2/5] Seeding organizations...');
  await seedOrganizations();
  console.log('');

  console.log('[3/5] Seeding roles...');
  await seedRoles();
  console.log('');

  console.log('[4/5] Seeding RBAC...');
  await seedRbac();
  console.log('');

  console.log('[5/5] Seeding dev users...');
  await seedDevUsers();
  console.log('');

  console.log('=== Setup complete ===');
  const managerEmail = process.env.SEED_MANAGER_EMAIL ?? 'pm@fluent.local';
  const managerPassword = process.env.SEED_MANAGER_PASSWORD ?? 'pm@123456';
  const translatorEmail = process.env.SEED_TRANSLATOR_EMAIL ?? 't@fluent.local';
  const translatorPassword = process.env.SEED_TRANSLATOR_PASSWORD ?? 't@123456';

  console.log(`Manager:    ${managerEmail} / ${managerPassword}`);
  console.log(`Translator: ${translatorEmail} / ${translatorPassword}`);
  process.exit(0);
}

setup().catch((err: unknown) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
