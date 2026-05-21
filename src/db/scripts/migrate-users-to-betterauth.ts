import { eq, isNull } from 'drizzle-orm';
import crypto from 'node:crypto';

import { db } from '../index';
import * as schema from '../schema';

async function migrateUsers() {
  console.log('Starting user migration to BetterAuth...');

  try {
    const usersToMigrate = await db
      .select()
      .from(schema.users)
      .where(isNull(schema.users.authUserId));

    if (usersToMigrate.length === 0) {
      console.log('No users pending migration. Exiting.');
      process.exit(0);
    }

    console.log(`Found ${usersToMigrate.length} users to migrate.`);

    for (const user of usersToMigrate) {
      const authUserId = crypto.randomUUID();

      const email = user.email || `${user.username}@fluent.bible`;
      const name = user.firstName
        ? `${user.firstName} ${user.lastName || ''}`.trim()
        : user.username;

      console.log(`Migrating user ${user.username} (${email})...`);

      await db.insert(schema.authUser).values({
        id: authUserId,
        email,
        name,
        emailVerified: user.status === 'verified',
        createdAt: user.createdAt || new Date(),
        updatedAt: user.updatedAt || new Date(),
      });

      await db.update(schema.users).set({ authUserId }).where(eq(schema.users.id, user.id));

      console.log(`Migrated user ${user.username} → authUserId: ${authUserId}`);
    }

    console.log('Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrateUsers();
