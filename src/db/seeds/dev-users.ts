import { hashPassword } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { RoleName } from '@/lib/roles';
import type { DbTransaction } from '@/lib/types';

import { db } from '@/db';
import { authAccount, authUser, organizations, roles, users } from '@/db/schema';
import { ROLES } from '@/lib/roles';

interface DevUserConfig {
  email: string;
  password: string;
  username: string;
  roleName: RoleName;
}

async function ensureCredentialPassword(
  tx: DbTransaction,
  authUserId: string,
  email: string,
  password: string
): Promise<void> {
  const hashedPassword = await hashPassword(password);

  const [credentialAccount] = await tx
    .select({ id: authAccount.id })
    .from(authAccount)
    .where(and(eq(authAccount.userId, authUserId), eq(authAccount.providerId, 'credential')))
    .limit(1);

  if (credentialAccount) {
    await tx
      .update(authAccount)
      .set({ password: hashedPassword, updatedAt: new Date() })
      .where(eq(authAccount.id, credentialAccount.id));
    return;
  }

  await tx.insert(authAccount).values({
    id: crypto.randomUUID(),
    userId: authUserId,
    accountId: email,
    providerId: 'credential',
    password: hashedPassword,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function seedDevUsers() {
  const DEV_USERS: DevUserConfig[] = [
    {
      email: process.env.SEED_MANAGER_EMAIL ?? 'pm@fluent.local',
      password: process.env.SEED_MANAGER_PASSWORD ?? 'pm@123456',
      username: 'devpm',
      roleName: ROLES.PROJECT_MANAGER,
    },
    {
      email: process.env.SEED_TRANSLATOR_EMAIL ?? 't@fluent.local',
      password: process.env.SEED_TRANSLATOR_PASSWORD ?? 't@123456',
      username: 'translator',
      roleName: ROLES.TRANSLATOR,
    },
  ];

  const [defaultOrg] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, 'Fluent Dev'))
    .limit(1);

  if (!defaultOrg) {
    throw new Error('Default organization "Fluent Dev" not found. Run seedOrganizations first.');
  }

  const allRoles = await db.select({ id: roles.id, name: roles.name }).from(roles);
  const roleMap = new Map(allRoles.map((r) => [r.name, r.id]));

  for (const config of DEV_USERS) {
    const roleId = roleMap.get(config.roleName);
    if (!roleId) {
      throw new Error(`Role "${config.roleName}" not found. Run seedRoles first.`);
    }

    await db.transaction(async (tx) => {
      const [existingAuthUser] = await tx
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, config.email))
        .limit(1);

      const [existingAppUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, config.email))
        .limit(1);

      if (existingAuthUser && existingAppUser) {
        await ensureCredentialPassword(tx, existingAuthUser.id, config.email, config.password);
        console.log(`Ensured dev user credentials: ${config.email} (${config.roleName})`);
        return;
      }

      if (existingAuthUser || existingAppUser) {
        throw new Error(
          `Dev user "${config.email}" is partially seeded (auth=${Boolean(existingAuthUser)}, users=${Boolean(existingAppUser)}). ` +
            'Run on a fresh database or repair manually.'
        );
      }

      const [existingUserByUsername] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, config.username))
        .limit(1);

      if (existingUserByUsername) {
        throw new Error(
          `Username "${config.username}" already exists for a different dev user. Resolve manually before re-seeding.`
        );
      }

      const authUserId = crypto.randomUUID();

      await tx.insert(authUser).values({
        id: authUserId,
        email: config.email,
        name: config.username,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await ensureCredentialPassword(tx, authUserId, config.email, config.password);

      await tx.insert(users).values({
        username: config.username,
        email: config.email,
        firstName: config.username,
        lastName: '(Dev)',
        role: roleId,
        organization: defaultOrg.id,
        status: 'verified',
        authUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      console.log(`Created dev user: ${config.email} (${config.roleName})`);
    });
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
