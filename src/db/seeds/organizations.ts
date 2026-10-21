import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { organizations } from '@/db/schema';

export async function seedOrganizations(orgName = 'Fluent Dev') {
  await db
    .insert(organizations)
    .values([{ name: orgName }])
    .onConflictDoNothing({ target: organizations.name });
  console.log(`Organizations seeded. (org: "${orgName}")`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedOrganizations()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
