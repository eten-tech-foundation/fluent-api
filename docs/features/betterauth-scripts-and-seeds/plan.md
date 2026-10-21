# BetterAuth Scripts & Seeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix bugs in all three dev scripts, refactor seeds to export functions, add missing org and dev-user seeds, and wire a single `db:setup` command that migrates and seeds a fresh local database in one step.

**Architecture:** Each seed file exports a named async function and retains a standalone entrypoint guard so it remains independently runnable. A new `src/db/scripts/setup.ts` orchestrator imports all seed functions and runs them in dependency order after spawning `drizzle-kit migrate` as a subprocess. No hardcoded role/org integer IDs — all lookups are by name.

**Tech Stack:** TypeScript, Drizzle ORM (`drizzle-orm/postgres-js`), BetterAuth (`better-auth/crypto`), tsx (ESM runner), Node.js `child_process`

---

## File Map

| Action | File                                            | Responsibility                                                    |
| ------ | ----------------------------------------------- | ----------------------------------------------------------------- |
| Modify | `src/db/scripts/create-user.ts`                 | Fix missing `auth_user` duplicate check; standardize to `console` |
| Modify | `src/db/scripts/set-password.ts`                | Replace `logger.error` with `console.error`                       |
| Modify | `src/db/scripts/migrate-users-to-betterauth.ts` | Replace `logger.error`/`logger.info` with `console`               |
| Modify | `src/db/seeds/roles.ts`                         | Export `seedRoles()`; add standalone guard                        |
| Modify | `src/db/seeds/rbac.ts`                          | Export `seedRbac()`; add standalone guard                         |
| Create | `src/db/seeds/organizations.ts`                 | `seedOrganizations()` — inserts default org idempotently          |
| Create | `src/db/seeds/dev-users.ts`                     | `seedDevUsers()` — creates Manager + Translator dev accounts      |
| Create | `src/db/scripts/setup.ts`                       | Orchestrates migrate → all seeds in dependency order              |
| Modify | `package.json`                                  | Add `db:setup`, `db:seed:org`, `db:seed:dev-users` scripts        |
| Modify | `.env.example`                                  | Add `SEED_*` env var documentation                                |

---

## Task 1: Fix `create-user.ts`

**Files:**

- Modify: `src/db/scripts/create-user.ts`

- [ ] **Step 1: Replace the file contents**

Replace `src/db/scripts/create-user.ts` with:

```ts
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
      .where(eq(schema.authUser.email, email));

    if (existingAuthUser) {
      console.error(
        `User with email ${email} already exists in auth_user. Use db:set-password instead.`
      );
      process.exit(1);
    }

    const [existingUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email));

    if (existingUser) {
      console.error(
        `User with email ${email} already exists in users. Use db:set-password instead.`
      );
      process.exit(1);
    }

    const authUserId = crypto.randomUUID();

    await db.insert(schema.authUser).values({
      id: authUserId,
      email,
      name: username,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const hashedPassword = await hashPassword(rawPassword);

    await db.insert(schema.authAccount).values({
      id: crypto.randomUUID(),
      userId: authUserId,
      accountId: email,
      providerId: 'credential',
      password: hashedPassword,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(schema.users).values({
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

    console.log(`Successfully created user: ${email}`);
    console.log(`Username: ${username}, Role: ${roleId === 1 ? 'Manager' : 'Translator'}`);
    process.exit(0);
  } catch (error) {
    console.error('Failed to create user:', error);
    process.exit(1);
  }
}

createNewUser();
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/db/scripts/create-user.ts
git commit -m "fix: check auth_user for duplicate email in create-user script"
```

---

## Task 2: Fix logger usage in `set-password.ts` and `migrate-users-to-betterauth.ts`

**Files:**

- Modify: `src/db/scripts/set-password.ts`
- Modify: `src/db/scripts/migrate-users-to-betterauth.ts`

- [ ] **Step 1: Replace `set-password.ts`**

```ts
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
    const [user] = await db.select().from(schema.authUser).where(eq(schema.authUser.email, email));

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
```

- [ ] **Step 2: Replace `migrate-users-to-betterauth.ts`**

```ts
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
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/scripts/set-password.ts src/db/scripts/migrate-users-to-betterauth.ts
git commit -m "fix: replace logger with console in dev scripts"
```

---

## Task 3: Refactor `roles.ts` seed to export a function

**Files:**

- Modify: `src/db/seeds/roles.ts`

- [ ] **Step 1: Replace file contents**

```ts
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
```

- [ ] **Step 2: Add `db:seed:roles` npm script to `package.json`**

In the `"scripts"` block, add after `"db:seed:rbac"`:

```json
"db:seed:roles": "npx tsx src/db/seeds/roles.ts",
```

- [ ] **Step 3: Verify standalone still works**

```bash
npm run db:seed:roles
```

Expected: `Roles seeded.` (or no-op if already seeded, no error).

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/seeds/roles.ts package.json
git commit -m "refactor: export seedRoles function from roles seed"
```

---

## Task 4: Refactor `rbac.ts` seed to export a function

**Files:**

- Modify: `src/db/seeds/rbac.ts`

- [ ] **Step 1: Replace file contents**

```ts
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { permissions, role_permissions, roles } from '@/db/schema';
import { PERMISSIONS } from '@/lib/permissions';
import { ROLES } from '@/lib/roles';

const PERMISSION_DEFINITIONS = [
  { name: PERMISSIONS.PROJECT_VIEW, description: 'View projects' },
  { name: PERMISSIONS.PROJECT_CREATE, description: 'Create new projects' },
  { name: PERMISSIONS.PROJECT_UPDATE, description: 'Update existing projects' },
  { name: PERMISSIONS.PROJECT_DELETE, description: 'Delete projects' },
  { name: PERMISSIONS.CONTENT_ASSIGN, description: 'Assign chapter assignment' },
  { name: PERMISSIONS.CONTENT_UPDATE, description: 'Update chapter assignment content' },
  { name: PERMISSIONS.USER_VIEW, description: 'View user profiles' },
  { name: PERMISSIONS.USER_CREATE, description: 'Create new users' },
  { name: PERMISSIONS.USER_UPDATE, description: 'Update user profiles' },
  { name: PERMISSIONS.USER_DELETE, description: 'Delete user' },
];

const ROLE_PERMISSION_MAP = [
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.PROJECT_VIEW },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.PROJECT_CREATE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.PROJECT_UPDATE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.PROJECT_DELETE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.CONTENT_ASSIGN },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.CONTENT_UPDATE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.USER_VIEW },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.USER_CREATE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.USER_UPDATE },
  { roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.USER_DELETE },
  { roleName: ROLES.TRANSLATOR, permissionName: PERMISSIONS.PROJECT_VIEW },
  { roleName: ROLES.TRANSLATOR, permissionName: PERMISSIONS.CONTENT_UPDATE },
  { roleName: ROLES.TRANSLATOR, permissionName: PERMISSIONS.USER_VIEW },
  { roleName: ROLES.TRANSLATOR, permissionName: PERMISSIONS.USER_UPDATE },
];

export async function seedRbac() {
  await db
    .insert(permissions)
    .values(PERMISSION_DEFINITIONS)
    .onConflictDoNothing({ target: permissions.name });

  const allRoles = await db.select({ id: roles.id, name: roles.name }).from(roles);
  const allPermissions = await db
    .select({ id: permissions.id, name: permissions.name })
    .from(permissions);

  const roleMap = new Map(allRoles.map((r) => [r.name, r.id]));
  const permissionMap = new Map(allPermissions.map((p) => [p.name, p.id]));

  const rolePermissionRows = ROLE_PERMISSION_MAP.map(({ roleName, permissionName }) => {
    const roleId = roleMap.get(roleName);
    const permissionId = permissionMap.get(permissionName);

    if (!roleId) throw new Error(`Role not found in DB: ${roleName}`);
    if (!permissionId) throw new Error(`Permission not found in DB: ${permissionName}`);

    return { roleId, permissionId };
  });

  await db.insert(role_permissions).values(rolePermissionRows).onConflictDoNothing();
  console.log('RBAC seeded.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedRbac()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Verify standalone still works**

```bash
npm run db:seed:rbac
```

Expected: `RBAC seeded.` (or no-op if already seeded, no error).

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/seeds/rbac.ts
git commit -m "refactor: export seedRbac function from rbac seed"
```

---

## Task 5: Create `organizations.ts` seed

**Files:**

- Create: `src/db/seeds/organizations.ts`

- [ ] **Step 1: Create the file**

```ts
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { organizations } from '@/db/schema';

const DEFAULT_ORGANIZATIONS = [{ name: 'ETEN Tech' }];

export async function seedOrganizations() {
  await db
    .insert(organizations)
    .values(DEFAULT_ORGANIZATIONS)
    .onConflictDoNothing({ target: organizations.name });
  console.log('Organizations seeded.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedOrganizations()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Add npm script to `package.json`**

In the `"scripts"` block, add after `"db:seed:rbac"`:

```json
"db:seed:org": "npx tsx src/db/seeds/organizations.ts",
```

- [ ] **Step 3: Verify it runs**

```bash
npm run db:seed:org
```

Expected: `Organizations seeded.`

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/seeds/organizations.ts package.json
git commit -m "feat: add organizations seed"
```

---

## Task 6: Create `dev-users.ts` seed

**Files:**

- Create: `src/db/seeds/dev-users.ts`

- [ ] **Step 1: Create the file**

```ts
import { fileURLToPath } from 'node:url';

import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

import { db } from '@/db';
import { authAccount, authUser, organizations, roles, users } from '@/db/schema';
import { ROLES, type RoleName } from '@/lib/roles';

type DevUserConfig = {
  email: string;
  password: string;
  username: string;
  roleName: RoleName;
};

const DEV_USERS: DevUserConfig[] = [
  {
    email: process.env.SEED_MANAGER_EMAIL ?? 'admin@fluent.local',
    password: process.env.SEED_MANAGER_PASSWORD ?? 'Manager@1234',
    username: 'admin',
    roleName: ROLES.PROJECT_MANAGER,
  },
  {
    email: process.env.SEED_TRANSLATOR_EMAIL ?? 'translator@fluent.local',
    password: process.env.SEED_TRANSLATOR_PASSWORD ?? 'Translator@1234',
    username: 'translator',
    roleName: ROLES.TRANSLATOR,
  },
];

export async function seedDevUsers() {
  const [defaultOrg] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, 'ETEN Tech'));

  if (!defaultOrg) {
    throw new Error('Default organization "ETEN Tech" not found. Run seedOrganizations first.');
  }

  const allRoles = await db.select({ id: roles.id, name: roles.name }).from(roles);
  const roleMap = new Map(allRoles.map((r) => [r.name, r.id]));

  for (const config of DEV_USERS) {
    const roleId = roleMap.get(config.roleName);
    if (!roleId) {
      throw new Error(`Role "${config.roleName}" not found. Run seedRoles first.`);
    }

    const [existingAuthUser] = await db
      .select()
      .from(authUser)
      .where(eq(authUser.email, config.email));

    if (existingAuthUser) {
      console.log(`Skipping ${config.email} — already exists in auth_user.`);
      continue;
    }

    const [existingUser] = await db.select().from(users).where(eq(users.email, config.email));

    if (existingUser) {
      console.log(`Skipping ${config.email} — already exists in users.`);
      continue;
    }

    const authUserId = crypto.randomUUID();
    const hashedPassword = await hashPassword(config.password);

    await db.insert(authUser).values({
      id: authUserId,
      email: config.email,
      name: config.username,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(authAccount).values({
      id: crypto.randomUUID(),
      userId: authUserId,
      accountId: config.email,
      providerId: 'credential',
      password: hashedPassword,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(users).values({
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
```

- [ ] **Step 2: Add npm script to `package.json`**

In the `"scripts"` block, add after `"db:seed:org"`:

```json
"db:seed:dev-users": "npx tsx src/db/seeds/dev-users.ts",
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/seeds/dev-users.ts package.json
git commit -m "feat: add dev-users seed with extensible config and env var fallbacks"
```

---

## Task 7: Create `setup.ts` orchestrator

**Files:**

- Create: `src/db/scripts/setup.ts`

- [ ] **Step 1: Create the file**

```ts
import { execSync } from 'node:child_process';

import { seedDevUsers } from '@/db/seeds/dev-users';
import { seedOrganizations } from '@/db/seeds/organizations';
import { seedRbac } from '@/db/seeds/rbac';
import { seedRoles } from '@/db/seeds/roles';

async function setup() {
  console.log('=== Fluent DB Setup ===\n');

  console.log('[1/5] Running migrations...');
  execSync('npx drizzle-kit migrate', { stdio: 'inherit' });
  console.log('Migrations complete.\n');

  console.log('[2/5] Seeding organizations...');
  await seedOrganizations();
  console.log('');

  console.log('[3/5] Seeding roles...');
  await seedRoles();
  console.log('');

  console.log('[4/5] Seeding RBAC...');
  await seedRbac();
  console.log('');

  console.log('[5/5] Seeding dev users...');
  await seedDevUsers();
  console.log('');

  console.log('=== Setup complete ===');
  console.log('Manager:    admin@fluent.local     / Manager@1234    (or SEED_MANAGER_* env vars)');
  console.log(
    'Translator: translator@fluent.local / Translator@1234 (or SEED_TRANSLATOR_* env vars)'
  );
  process.exit(0);
}

setup().catch((err: unknown) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add `db:setup` script to `package.json`**

In the `"scripts"` block, add before `"db:migrate"`:

```json
"db:setup": "npx tsx src/db/scripts/setup.ts",
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/scripts/setup.ts package.json
git commit -m "feat: add db:setup orchestrator script"
```

---

## Task 8: Update `.env.example`

**Files:**

- Modify: `.env.example`

- [ ] **Step 1: Add seed env vars**

Append to `.env.example`:

```
# Dev seed user credentials (used by npm run db:seed:dev-users and db:setup)
SEED_MANAGER_EMAIL=admin@fluent.local
SEED_MANAGER_PASSWORD=Manager@1234
SEED_TRANSLATOR_EMAIL=translator@fluent.local
SEED_TRANSLATOR_PASSWORD=Translator@1234
```

- [ ] **Step 2: End-to-end smoke test on a fresh DB**

Drop and recreate your local DB, then run:

```bash
npm run db:setup
```

Expected output (in order):

```
=== Fluent DB Setup ===

[1/5] Running migrations...
... (drizzle-kit output) ...
Migrations complete.

[2/5] Seeding organizations...
Organizations seeded.

[3/5] Seeding roles...
Roles seeded.

[4/5] Seeding RBAC...
RBAC seeded.

[5/5] Seeding dev users...
Created dev user: admin@fluent.local (Manager)
Created dev user: translator@fluent.local (Translator)
Dev users seeded.

=== Setup complete ===
Manager:    admin@fluent.local     / Manager@1234    (or SEED_MANAGER_* env vars)
Translator: translator@fluent.local / Translator@1234 (or SEED_TRANSLATOR_* env vars)
```

Run a second time to verify idempotency — all seed steps should skip or no-op cleanly with no errors.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: add seed env vars to .env.example"
```
