import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { roles } from '@/db/schema';
import { ROLES } from '@/lib/roles';

const ROLE_DEFINITIONS = Object.values(ROLES).map((name) => ({ name }));

export async function seedRoles() {
  await db.insert(roles).values(ROLE_DEFINITIONS).onConflictDoNothing({ target: roles.name });
  console.log('Roles seeded.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedRoles()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
