import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { SeedUser } from '@/db/env-configs/types';

import { db } from '@/db';
import { authAccount, authUser, organizations, roles, user_roles, users } from '@/db/schema';
import { ROLES } from '@/lib/roles';

// Re-export so callers that only import this module don't need env-configs/types.
export type { SeedUser };

/** Default users used when the seed is run standalone (CLI) without arguments. */
const DEFAULT_SEED_USERS: SeedUser[] = [
  {
    email: process.env.SEED_MANAGER_EMAIL ?? 'pm@fluent.local',
    password: process.env.SEED_MANAGER_PASSWORD ?? 'pm@123456',
    username: 'devpm',
    role: 'project_manager',
  },
  {
    email: process.env.SEED_TRANSLATOR_EMAIL ?? 't@fluent.local',
    password: process.env.SEED_TRANSLATOR_PASSWORD ?? 't@123456',
    username: 'translator',
    role: 'project_translator',
  },
  {
    email: process.env.SEED_TRANSLATOR2_EMAIL ?? 't2@fluent.local',
    password: process.env.SEED_TRANSLATOR2_PASSWORD ?? 't@123456',
    username: 'translator2',
    role: 'project_translator',
  },
];

/**
 * Universal user seeding module for all environments (local, dev, qa).
 *
 * @param seedUsers - Users to create. Defaults to the 3-user local dev set.
 * @param orgName   - Organisation these users belong to. Defaults to 'Fluent Dev'.
 */
export async function seedDevUsers(
  seedUsers: SeedUser[] = DEFAULT_SEED_USERS,
  orgName = 'Fluent Dev'
) {
  if (seedUsers.length === 0) {
    console.log('No seed users configured — skipping.');
    return;
  }

  const [defaultOrg] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, orgName))
    .limit(1);

  if (!defaultOrg) {
    throw new Error(`Organization "${orgName}" not found. Run seedOrganizations first.`);
  }

  const allRoles = await db.select({ id: roles.id, name: roles.name }).from(roles);
  const roleMap = new Map(allRoles.map((r) => [r.name, r.id]));

  const orgMemberRoleId = roleMap.get(ROLES.ORG_MEMBER);
  if (!orgMemberRoleId) {
    throw new Error(`Role "${ROLES.ORG_MEMBER}" not found. Run seedRoles first.`);
  }

  for (const seedUser of seedUsers) {
    const authUserId = crypto.randomUUID();
    const hashedPassword = await hashPassword(seedUser.password);

    await db.transaction(async (tx) => {
      const [existingAuthUser] = await tx
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, seedUser.email))
        .limit(1);

      if (existingAuthUser) {
        console.log(`Skipping ${seedUser.email} — already exists in auth_user.`);
        return;
      }

      const [existingUserByEmail] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, seedUser.email))
        .limit(1);

      if (existingUserByEmail) {
        console.log(`Skipping ${seedUser.email} — already exists in users.`);
        return;
      }

      const [existingUserByUsername] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, seedUser.username))
        .limit(1);

      if (existingUserByUsername) {
        console.log(`Skipping ${seedUser.username} — username already exists in users.`);
        return;
      }

      await tx.insert(authUser).values({
        id: authUserId,
        email: seedUser.email,
        name: seedUser.username,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await tx.insert(authAccount).values({
        id: crypto.randomUUID(),
        userId: authUserId,
        accountId: seedUser.email,
        providerId: 'credential',
        password: hashedPassword,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const [newUser] = await tx
        .insert(users)
        .values({
          username: seedUser.username,
          email: seedUser.email,
          firstName: seedUser.username,
          lastName: '(Dev)',
          status: 'verified',
          authUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: users.id });

      // Grant mandatory Org Member anchor role
      await tx.insert(user_roles).values({
        userId: newUser.id,
        orgId: defaultOrg.id,
        roleId: orgMemberRoleId,
        createdBy: newUser.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // If the user is designated as project_manager, grant org-wide Project Manager role
      if (seedUser.role === 'project_manager') {
        const pmRoleId = roleMap.get(ROLES.PROJECT_MANAGER);
        if (pmRoleId) {
          await tx.insert(user_roles).values({
            userId: newUser.id,
            orgId: defaultOrg.id,
            roleId: pmRoleId,
            createdBy: newUser.id,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }

      console.log(`Created user: ${seedUser.email} (${seedUser.role})`);
    });
  }

  console.log('Dev users seeded.');
}

export { seedDevUsers as seedUsers };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedDevUsers()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
