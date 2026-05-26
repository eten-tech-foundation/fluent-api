import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

import { db } from '../index';
import * as schema from '../schema';

async function createNewUser() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('Usage: npm run db:create-user <email> <password> <username> [roleId]');
    console.error('Example: npm run db:create-user john.doe@example.com Test@1234 johndoe 2');
    process.exit(1);
  }

  const email = args[0].toLowerCase();
  const rawPassword = args[1];
  const username = args[2];
  const roleId = args.length > 3 ? Number.parseInt(args[3], 10) : 2;
  const organizationId = 1;

  try {
    const [existingAuthUser] = await db
      .select()
      .from(schema.authUser)
      .where(eq(schema.authUser.email, email))
      .limit(1);

    if (existingAuthUser) {
      console.error(
        `User with email ${email} already exists in auth_user. Use db:set-password instead.`
      );
      process.exit(1);
    }

    const [existingUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (existingUser) {
      console.error(
        `User with email ${email} already exists in users. Use db:set-password instead.`
      );
      process.exit(1);
    }

    const authUserId = crypto.randomUUID();
    const hashedPassword = await hashPassword(rawPassword);

    await db.transaction(async (tx) => {
      await tx.insert(schema.authUser).values({
        id: authUserId,
        email,
        name: username,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await tx.insert(schema.authAccount).values({
        id: crypto.randomUUID(),
        userId: authUserId,
        accountId: email,
        providerId: 'credential',
        password: hashedPassword,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await tx.insert(schema.users).values({
        username,
        email,
        firstName: username,
        lastName: '(QA)',
        role: roleId,
        organization: organizationId,
        status: 'verified',
        authUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    console.log(`Successfully created user: ${email}`);
    console.log(`Username: ${username}, Role: ${roleId === 1 ? 'Manager' : 'Translator'}`);
    process.exit(0);
  } catch (error) {
    console.error('Failed to create user:', error);
    process.exit(1);
  }
}

createNewUser();
