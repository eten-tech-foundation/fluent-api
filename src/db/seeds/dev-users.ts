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

export interface ReconcileSeedUserInput {
  email: string;
  username: string;
  /** Plaintext — hashed at seed time. */
  password?: string;
  /** Committed better-auth hash — written directly, no hashing. */
  passwordHash?: string;
  firstName?: string;
  lastName?: string;
  /** users.createdBy — the actor creating this account (null for self/first). */
  createdBy: number | null;
}

/**
 * Shared user writer: create or reconcile the auth_user + auth_account +
 * users triple for one seed account. Accepts a plaintext password (hashed at
 * seed time) or a committed better-auth hash (written verbatim).
 *
 * Returns the application `users.id`, or null when the row was skipped
 * (username taken by a different account, or auth_user exists without a
 * matching users row).
 */
export async function reconcileSeedUser(
  input: ReconcileSeedUserInput
): Promise<number | null> {
  if (!input.password && !input.passwordHash) {
    throw new Error(`Seed user ${input.email} has neither password nor passwordHash.`);
  }
  const hashedPassword = input.passwordHash ?? (await hashPassword(input.password!));
  const authUserId = crypto.randomUUID();

  let appUserId: number | null = null;

  await db.transaction(async (tx) => {
    // ── Resolve existing account or create a new one ─────────────────────
    const [existingAuthUser] = await tx
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, input.email))
      .limit(1);

    const [existingUserByEmail] = await tx
      .select({ id: users.id, authUserId: users.authUserId })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);

    const [existingUserByUsername] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, input.username))
      .limit(1);

    if (existingAuthUser || existingUserByEmail) {
      // Account already exists — the email-keyed users row is the one to reconcile.
      const resolvedAppUser = existingUserByEmail;

      if (!resolvedAppUser) {
        console.log(`Skipping ${input.email} — auth_user exists but no matching users row.`);
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

      console.log(`User ${input.email} reconciled (roles & password updated).`);
    } else if (existingUserByUsername) {
      console.log(`Skipping ${input.username} — username already taken by a different user.`);
    } else {
      // Create new account.
      await tx.insert(authUser).values({
        id: authUserId,
        email: input.email,
        name: input.username,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await tx.insert(authAccount).values({
        id: crypto.randomUUID(),
        userId: authUserId,
        accountId: input.email,
        providerId: 'credential',
        password: hashedPassword,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const [newUser] = await tx
        .insert(users)
        .values({
          username: input.username,
          email: input.email,
          firstName: input.firstName ?? input.username,
          lastName: input.lastName ?? null,
          status: 'verified',
          authUserId,
          createdBy: input.createdBy,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: users.id });

      appUserId = newUser.id;
      console.log(`Created user: ${input.email}`);
    }
  });

  return appUserId;
}

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
    const appUserId = await reconcileSeedUser({
      email: seedUser.email,
      username: seedUser.username,
      password: seedUser.password,
      lastName: '(Dev)',
      createdBy: pmUserId,
    });

    if (appUserId === null) {
      continue;
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
    const existingGrants = await db
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
      await db.insert(user_roles).values({
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
        await db.insert(user_roles).values({
          userId: appUserId,
          orgId: defaultOrg.id,
          roleId: pmRoleId,
          createdBy: grantedBy,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }
  }

  console.log('Dev users seeded.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedDevUsers()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
