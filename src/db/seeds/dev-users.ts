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
      // ── Resolve existing account or create a new one ─────────────────────
      const [existingAuthUser] = await tx
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, seedUser.email))
        .limit(1);

      const [existingUserByUsername] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, seedUser.username))
        .limit(1);

      let appUserId: number;

      if (existingAuthUser) {
        // Account already exists — resolve the application user for role reconciliation.
        const [existingAppUser] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, seedUser.email))
          .limit(1);

        if (!existingAppUser) {
          console.log(`Skipping ${seedUser.email} — auth_user exists but no matching users row.`);
          return;
        }

        appUserId = existingAppUser.id;
        console.log(`User ${seedUser.email} already exists — reconciling roles.`);
      } else if (existingUserByUsername) {
        console.log(`Skipping ${seedUser.username} — username already taken by a different user.`);
        return;
      } else {
        // Create new account.
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

        appUserId = newUser.id;
        console.log(`Created user: ${seedUser.email} (${seedUser.role})`);
      }

      // ── Reconcile required role grants ────────────────────────────────────
      // Fetch existing role grants for this user in this org.
      const existingGrants = await tx
        .select({ roleId: user_roles.roleId })
        .from(user_roles)
        .where(eq(user_roles.userId, appUserId));

      const grantedRoleIds = new Set(existingGrants.map((g) => g.roleId));

      // Insert Org Member anchor role if missing.
      if (!grantedRoleIds.has(orgMemberRoleId)) {
        await tx.insert(user_roles).values({
          userId: appUserId,
          orgId: defaultOrg.id,
          roleId: orgMemberRoleId,
          createdBy: appUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Insert Project Manager role if this user is designated as one and it is missing.
      if (seedUser.role === 'project_manager') {
        const pmRoleId = roleMap.get(ROLES.PROJECT_MANAGER);
        if (pmRoleId && !grantedRoleIds.has(pmRoleId)) {
          await tx.insert(user_roles).values({
            userId: appUserId,
            orgId: defaultOrg.id,
            roleId: pmRoleId,
            createdBy: appUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }
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
