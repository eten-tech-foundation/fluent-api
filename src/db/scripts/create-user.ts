import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

import { ROLES } from '../../lib/roles';
import { db } from '../index';
import * as schema from '../schema';

async function createNewUser() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error(
      'Usage: npm run db:create-user <email> <password> <username> [roleName] [orgId] [projectId]'
    );
    console.error(
      'Example: npm run db:create-user john.doe@example.com Test@1234 johndoe "Project Manager" 1 10'
    );
    process.exit(1);
  }

  const email = args[0].toLowerCase();
  const rawPassword = args[1];
  const username = args[2];
  const roleNameStr = args[3] || ROLES.PROJECT_TRANSLATOR;
  const orgIdArg = args[4] ? Number.parseInt(args[4], 10) : undefined;
  const projectIdArg = args[5] ? Number.parseInt(args[5], 10) : undefined;

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

    const [role] = await db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.name, roleNameStr))
      .limit(1);

    if (!role) {
      console.error(`Role '${roleNameStr}' not found in database.`);
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

      const [newUser] = await tx
        .insert(schema.users)
        .values({
          username,
          email,
          firstName: username,
          lastName: '(QA)',
          status: 'verified',
          authUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: schema.users.id });

      let grantOrgId: number | null = null;
      let grantProjectId: number | null = null;

      if (role.name !== ROLES.SUPER_ADMIN) {
        if (orgIdArg === undefined || Number.isNaN(orgIdArg)) {
          throw new Error(`Role '${role.name}' requires a valid orgId argument.`);
        }
        grantOrgId = orgIdArg;

        if (
          role.name === ROLES.PROJECT_TRANSLATOR ||
          role.name === ROLES.PROJECT_OBSERVER ||
          role.name === ROLES.PROJECT_MANAGER
        ) {
          if (projectIdArg === undefined || Number.isNaN(projectIdArg)) {
            throw new Error(`Role '${role.name}' requires a valid projectId argument.`);
          }
          grantProjectId = projectIdArg;
        }
      }

      await tx.insert(schema.user_roles).values({
        userId: newUser.id,
        orgId: grantOrgId,
        projectId: grantProjectId,
        roleId: role.id,
        createdBy: newUser.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    console.log(`Successfully created user: ${email}`);
    console.log(`Username: ${username}, Role: ${role.name}`);
    process.exit(0);
  } catch (error) {
    console.error('Failed to create user:', error);
    process.exit(1);
  }
}

createNewUser();
