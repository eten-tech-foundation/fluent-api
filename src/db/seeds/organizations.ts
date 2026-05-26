import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { organizations } from '@/db/schema';

const DEFAULT_ORGANIZATIONS = [{ name: 'Fluent Dev' }];

export async function seedOrganizations() {
  await db
    .insert(organizations)
    .values(DEFAULT_ORGANIZATIONS)
    .onConflictDoNothing({ target: organizations.name });
  console.log('Organizations seeded.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedOrganizations()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
