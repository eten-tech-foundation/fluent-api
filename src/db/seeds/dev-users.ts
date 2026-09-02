import { hashPassword } from 'better-auth/crypto';
import { and, eq, isNull } from 'drizzle-orm';
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
 * @param orgName   - Organisation these users belong to. Defaults to 'Fluent Dev'.\
 *
 * Seeding order: PM is always created first so its DB id can be used as the
 * `createdBy` actor for all subsequent (translator / org-member) role grants,
 * mirroring real application behaviour where a PM invites team members.
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

  const pmRoleId = roleMap.get(ROLES.PROJECT_MANAGER);
  if (!pmRoleId && seedUsers.some((u) => u.role === 'project_manager')) {
    throw new Error(`Role "${ROLES.PROJECT_MANAGER}" not found. Run seedRoles first.`);
  }

  // Seed PM first so we have a real actor id to use as createdBy for translators.
  const pmUsers = seedUsers.filter((u) => u.role === 'project_manager');
  const otherUsers = seedUsers.filter((u) => u.role !== 'project_manager');
  const ordered = [...pmUsers, ...otherUsers];

  // Tracks the first PM's app user id; falls back to self for non-PM seeds
  // when no PM is present in the list (e.g. standalone CLI run).
  let pmUserId: number | null = null;

  for (const seedUser of ordered) {
    const authUserId = crypto.randomUUID();
    const hashedPassword = await hashPassword(seedUser.password);

    await db.transaction(async (tx) => {
      // ── Resolve existing account or create a new one ─────────────────────
      const [existingAuthUser] = await tx
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, seedUser.email))
        .limit(1);

      const [existingUserByEmail] = await tx
        .select({ id: users.id, authUserId: users.authUserId })
        .from(users)
        .where(eq(users.email, seedUser.email))
        .limit(1);

      const [existingUserByUsername] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, seedUser.username))
        .limit(1);

      let appUserId: number;

      if (existingAuthUser || existingUserByEmail) {
        // Account already exists — resolve the application user for role/password reconciliation.
        const resolvedAppUser =
          existingUserByEmail ??
          (
            await tx
              .select({ id: users.id, authUserId: users.authUserId })
              .from(users)
              .where(eq(users.email, seedUser.email))
              .limit(1)
          )[0];

        if (!resolvedAppUser) {
          console.log(`Skipping ${seedUser.email} — auth_user exists but no matching users row.`);
          return;
        }

        appUserId = resolvedAppUser.id;
        const targetAuthUserId = existingAuthUser?.id ?? resolvedAppUser.authUserId;

        // Password rotation: update stored password hash on reconcile
        if (targetAuthUserId) {
          await tx
            .update(authAccount)
            .set({
              password: hashedPassword,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(authAccount.userId, targetAuthUserId),
                eq(authAccount.providerId, 'credential')
              )
            );
        }

        console.log(`User ${seedUser.email} reconciled (roles & password updated).`);
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
            createdBy: pmUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .returning({ id: users.id });

        appUserId = newUser.id;
        console.log(`Created user: ${seedUser.email} (${seedUser.role})`);
      }

      // Capture the first PM id so translators show as invited by the PM.
      if (seedUser.role === 'project_manager' && pmUserId === null) {
        pmUserId = appUserId;
      }

      // Role grants use the PM as the actor for non-PM users (mirrors real usage),
      // falling back to self when no PM has been seeded yet (standalone CLI).
      const grantedBy = pmUserId ?? appUserId;

      // ── Reconcile required role grants ────────────────────────────────────
      // Scope the check to (orgId = defaultOrg.id, projectId IS NULL) —
      // matching the uniqueness constraint (userId, COALESCE(orgId,-1),
      // COALESCE(projectId,-1), roleId). Without this, a project-scoped grant
      // for the same roleId would shadow the check and the org-level grant
      // would be silently skipped.
      const existingGrants = await tx
        .select({ roleId: user_roles.roleId })
        .from(user_roles)
        .where(
          and(
            eq(user_roles.userId, appUserId),
            eq(user_roles.orgId, defaultOrg.id),
            isNull(user_roles.projectId)
          )
        );

      const grantedRoleIds = new Set(existingGrants.map((g) => g.roleId));

      // Insert Org Member anchor role if missing.
      if (!grantedRoleIds.has(orgMemberRoleId)) {
        await tx.insert(user_roles).values({
          userId: appUserId,
          orgId: defaultOrg.id,
          roleId: orgMemberRoleId,
          createdBy: grantedBy,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Insert Project Manager role if this user is designated as one and it is missing.
      if (seedUser.role === 'project_manager' && pmRoleId) {
        if (!grantedRoleIds.has(pmRoleId)) {
          await tx.insert(user_roles).values({
            userId: appUserId,
            orgId: defaultOrg.id,
            roleId: pmRoleId,
            createdBy: grantedBy,
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
