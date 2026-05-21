import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

import { db } from '../index';
import * as schema from '../schema';

async function setPassword() {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.error('Usage: npm run db:set-password <email> <password>');
    process.exit(1);
  }

  const email = args[0].toLowerCase();
  const rawPassword = args[1];

  try {
    const [user] = await db
      .select()
      .from(schema.authUser)
      .where(eq(schema.authUser.email, email))
      .limit(1);

    if (!user) {
      console.error(`User with email ${email} not found in auth_user table.`);
      console.error('Please ensure they are migrated first or create them with db:create-user.');
      process.exit(1);
    }

    const hashedPassword = await hashPassword(rawPassword);

    const existingAccounts = await db
      .select()
      .from(schema.authAccount)
      .where(eq(schema.authAccount.userId, user.id));

    const credentialAccount = existingAccounts.find((acc) => acc.providerId === 'credential');

    if (credentialAccount) {
      await db
        .update(schema.authAccount)
        .set({ password: hashedPassword, updatedAt: new Date() })
        .where(eq(schema.authAccount.id, credentialAccount.id));

      console.log(`Successfully updated password for ${email}`);
    } else {
      await db.insert(schema.authAccount).values({
        id: crypto.randomUUID(),
        userId: user.id,
        accountId: email,
        providerId: 'credential',
        password: hashedPassword,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      console.log(`Successfully created password credentials for ${email}`);
    }

    process.exit(0);
  } catch (error) {
    console.error('Failed to set password:', error);
    process.exit(1);
  }
}

setPassword();
