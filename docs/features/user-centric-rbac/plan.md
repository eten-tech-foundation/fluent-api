# User-Central RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the User the central tenant: one user can hold many roles scoped per-org and/or per-project, resolved through a single data-driven authorization function.

**Architecture:** Introduce a `user_roles(user_id, org_id?, project_id?, role_id)` grant table. Org membership becomes emergent (a user is "in" an org iff they hold a grant with that `org_id`). Authorization collapses to one function `authorize(user, permission, scope)` that selects applicable grants by scope and tests permission-set membership. SuperAdmin is a global grant (both scopes null) with all permissions. The work is staged: **additive phases** (new tables, engine, grant loading) keep the build green alongside the old model; a **switch-over phase** replaces `AppPolicyUser`/policies/middleware in one coordinated pass; then a **migration + teardown phase** backfills the ~24 production users and drops the old columns/tables.

**Tech Stack:** TypeScript (ESM), Hono + `@hono/zod-openapi`, Drizzle ORM (PostgreSQL), drizzle-kit migrations, BetterAuth, Vitest, `tsx`. Test command: `npm test` (`cross-env NODE_ENV=test vitest`). Full gate: `npm run precheck` (lint + format:check + typecheck + test).

**Spec:** `docs/features/user-centric-rbac/design.md`

---

## File Structure

**New files**
- `src/domains/user-roles/user-roles.repository.ts` — load a user's grants (joined to permissions), grouped into `Grant[]`.
- `src/domains/user-roles/user-roles.service.ts` — grant CRUD used by migration + invitation (create/revoke a grant).
- `src/lib/services/permissions/authorize.ts` — the `authorize` / `collectPermissions` / `isGrantApplicable` engine (pure, no DB).
- `src/lib/services/permissions/authorize.test.ts` — engine unit tests.
- `src/db/scripts/migrate-to-user-central-rbac.ts` — one-shot data migration.

**Modified files**
- `src/lib/roles.ts` — full role-name set.
- `src/lib/permissions.ts` — add `content:view`, `membership:revoke`, `role:assign:project`, `role:assign:org_manager`.
- `src/db/schema.ts` — add `user_roles` table + zod schemas (Phase 0); drop `users.organization`, `users.role`, `project_users` (Phase 4).
- `src/lib/types.ts` — `Grant`, `AuthScope`; rework `AppPolicyUser` and context `User`.
- `src/lib/services/permissions/permissions.service.ts` — re-export `authorize`; remove obsolete `roleHasPermission`.
- `src/middlewares/authenticate.ts` — load grants onto `c.get('user')`.
- `src/middlewares/role-auth.ts` — `requirePermission(permission, scopeFn)`.
- Policy/middleware/route files per domain (Phase 3): `projects`, `chapter-assignments`, `projects/chapter-assignments`, `translated-verses`, `users`.
- `src/domains/projects/users/project-users.service.ts` — `resolveIsProjectMember` queries `user_roles`.
- `src/db/seeds/roles.ts`, `src/db/seeds/rbac.ts` — new roles + permission map.

---

## Phase 0 — Constants & schema (additive, build stays green)

### Task 1: Expand role-name constants

**Files:**
- Modify: `src/lib/roles.ts`

- [ ] **Step 1: Replace the constants file**

```ts
export const ROLES = {
  SUPER_ADMIN: 'SuperAdmin',
  ORG_OWNER: 'Org Owner',
  ORG_MANAGER: 'Org Manager',
  PROJECT_MANAGER: 'Project Manager',
  PROJECT_TRANSLATOR: 'Project Translator',
  PROJECT_OBSERVER: 'Project Observer',
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];
```

Note: the string values for `PROJECT_MANAGER` and `PROJECT_TRANSLATOR` change from `'Manager'`/`'Translator'`. Existing `roles` rows are renamed by the migration (Task 16/17). The old `ROLES.TRANSLATOR` key is removed; Phase 3 updates every reference.

- [ ] **Step 2: Find references that must change later**

Run: `grep -rn "ROLES.TRANSLATOR\b\|ROLES.PROJECT_MANAGER" src --include='*.ts'`
Expected: a list of policy/middleware files — these are handled in Phase 3. No action now.

- [ ] **Step 3: Commit**

```bash
git add src/lib/roles.ts
git commit -m "feat(rbac): expand role-name constants for user-central model"
```

### Task 2: Add new permission constants

**Files:**
- Modify: `src/lib/permissions.ts`

- [ ] **Step 1: Add the four new permission entries**

Inside the `PERMISSIONS` object, add:

```ts
  // ── Content ─────────────────────────────────────────────────────────
  CONTENT_VIEW: 'content:view',
  CONTENT_ASSIGN: 'content:assign',
  CONTENT_UPDATE: 'content:update',

  // ── Membership / role assignment ────────────────────────────────────
  MEMBERSHIP_REVOKE: 'membership:revoke',
  ROLE_ASSIGN_PROJECT: 'role:assign:project',
  ROLE_ASSIGN_ORG_MANAGER: 'role:assign:org_manager',
```

(Keep `USER_DELETE` — it stays defined but is seeded to no role except SuperAdmin, deferring account deletion. See spec.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no consumers reference the new names yet).

- [ ] **Step 3: Commit**

```bash
git add src/lib/permissions.ts
git commit -m "feat(rbac): add content:view, membership:revoke, role:assign:* permissions"
```

### Task 3: Add the `user_roles` table to the schema

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add the table after `role_permissions` (around line 479)**

```ts
export const user_roles = pgTable(
  'user_roles',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: integer('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id),
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_user_role_grant').on(
      table.userId,
      table.orgId,
      table.projectId,
      table.roleId
    ),
    index('idx_user_roles_user').on(table.userId),
    index('idx_user_roles_org').on(table.orgId),
    index('idx_user_roles_project').on(table.projectId),
  ]
);
```

- [ ] **Step 2: Add zod schemas alongside the other `createSelectSchema`/`createInsertSchema` blocks**

```ts
export const selectUserRolesSchema = createSelectSchema(user_roles);

export const insertUserRolesSchema = createInsertSchema(user_roles, {
  userId: (schema) => schema.int(),
  orgId: (schema) => schema.int().optional(),
  projectId: (schema) => schema.int().optional(),
  roleId: (schema) => schema.int(),
})
  .required({ userId: true, roleId: true })
  .omit({ id: true, createdAt: true, updatedAt: true });

export const patchUserRolesSchema = insertUserRolesSchema.partial();
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate -- add_user_roles`
Expected: a new file under `src/db/migrations/` creating `user_roles`. Inspect it; it must NOT drop `users.organization`, `users.role`, or `project_users` (those happen in Phase 4).

- [ ] **Step 4: Apply and typecheck**

Run: `npm run db:migrate && npm run typecheck`
Expected: migration applies; typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/migrations/
git commit -m "feat(rbac): add user_roles grant table"
```

---

## Phase 1 — Authorization engine (pure, fully unit-tested)

### Task 4: Define `Grant`, `AuthScope`, and the new `AppPolicyUser`

**Files:**
- Modify: `src/lib/types.ts:153-160`

- [ ] **Step 1: Add types near the existing `AppPolicyUser` (replace that interface)**

```ts
import type { Permission } from '@/lib/permissions';

/** One authorization grant, flattened to its effective permissions. */
export interface Grant {
  orgId: number | null;
  projectId: number | null;
  permissions: ReadonlySet<Permission>;
}

/** The scope an action is evaluated against. */
export interface AuthScope {
  orgId?: number | null;
  projectId?: number | null;
}

/** Shared identity for authorization policies across all domains. */
export interface AppPolicyUser {
  id: number;
  grants: Grant[];
}
```

(`Permission` import: add to the existing import block at the top of `types.ts`. If a circular-import lint error appears, use `import type`.)

- [ ] **Step 2: Typecheck (expect errors — they are the Phase 3 worklist)**

Run: `npm run typecheck`
Expected: FAIL — every current reference to `user.roleName` / `user.organization` on an `AppPolicyUser` now errors. This is the exhaustive list of files Phase 3 must fix. Capture it; do not fix yet.

- [ ] **Step 3: Commit (types only)**

```bash
git add src/lib/types.ts
git commit -m "feat(rbac): introduce Grant/AuthScope and grant-based AppPolicyUser"
```

> Build is intentionally red between Task 4 and the end of Phase 3. Phase 3 restores green.

### Task 5: Implement the authorization engine (TDD)

**Files:**
- Create: `src/lib/services/permissions/authorize.ts`
- Test: `src/lib/services/permissions/authorize.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';

import type { Grant } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';

import { authorize, collectPermissions } from './authorize';

const grant = (
  orgId: number | null,
  projectId: number | null,
  perms: string[]
): Grant => ({ orgId, projectId, permissions: new Set(perms) as ReadonlySet<any> });

describe('authorize', () => {
  const ORG = 1;
  const OTHER_ORG = 2;
  const PROJ = 10;
  const OTHER_PROJ = 11;

  it('SuperAdmin (global grant) passes any scope', () => {
    const user = { id: 1, grants: [grant(null, null, [PERMISSIONS.PROJECT_DELETE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_DELETE, { orgId: ORG, projectId: PROJ })).toBe(true);
    expect(authorize(user, PERMISSIONS.PROJECT_DELETE, { orgId: OTHER_ORG })).toBe(true);
  });

  it('org-wide PM grant applies to any project in that org', () => {
    const user = { id: 1, grants: [grant(ORG, null, [PERMISSIONS.PROJECT_UPDATE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_UPDATE, { orgId: ORG, projectId: PROJ })).toBe(true);
    expect(authorize(user, PERMISSIONS.PROJECT_UPDATE, { orgId: ORG, projectId: OTHER_PROJ })).toBe(true);
  });

  it('project-pinned grant does NOT apply to a sibling project', () => {
    const user = { id: 1, grants: [grant(ORG, PROJ, [PERMISSIONS.PROJECT_UPDATE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_UPDATE, { orgId: ORG, projectId: PROJ })).toBe(true);
    expect(authorize(user, PERMISSIONS.PROJECT_UPDATE, { orgId: ORG, projectId: OTHER_PROJ })).toBe(false);
  });

  it('project-pinned PM grant counts for an org-scoped action (create project)', () => {
    const user = { id: 1, grants: [grant(ORG, PROJ, [PERMISSIONS.PROJECT_CREATE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_CREATE, { orgId: ORG })).toBe(true);
  });

  it('translator grant lacking project:create is denied an org-scoped create', () => {
    const user = { id: 1, grants: [grant(ORG, PROJ, [PERMISSIONS.CONTENT_UPDATE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_CREATE, { orgId: ORG })).toBe(false);
  });

  it('grants in a different org never apply', () => {
    const user = { id: 1, grants: [grant(OTHER_ORG, null, [PERMISSIONS.PROJECT_UPDATE])] };
    expect(authorize(user, PERMISSIONS.PROJECT_UPDATE, { orgId: ORG, projectId: PROJ })).toBe(false);
  });

  it('collectPermissions unions across applicable grants', () => {
    const user = {
      id: 1,
      grants: [
        grant(ORG, null, [PERMISSIONS.PROJECT_VIEW]),
        grant(ORG, PROJ, [PERMISSIONS.CONTENT_UPDATE]),
        grant(OTHER_ORG, null, [PERMISSIONS.PROJECT_DELETE]),
      ],
    };
    const perms = collectPermissions(user.grants, { orgId: ORG, projectId: PROJ });
    expect(perms.has(PERMISSIONS.PROJECT_VIEW)).toBe(true);
    expect(perms.has(PERMISSIONS.CONTENT_UPDATE)).toBe(true);
    expect(perms.has(PERMISSIONS.PROJECT_DELETE)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- authorize`
Expected: FAIL — `./authorize` module not found.

- [ ] **Step 3: Implement the engine**

```ts
import type { Permission } from '@/lib/permissions';
import type { AppPolicyUser, AuthScope, Grant } from '@/lib/types';

/**
 * A grant applies to a request scope when:
 *  - it is global (org + project both null) — SuperAdmin; OR
 *  - the request is project-scoped (projectId given) and the grant is either
 *    pinned to that project, or an org-wide role over that project's org; OR
 *  - the request is org-scoped (no project) and the grant lives in that org
 *    (org-wide OR pinned to any project in it).
 */
function isGrantApplicable(
  grant: Grant,
  orgId: number | null,
  projectId: number | null
): boolean {
  if (grant.orgId === null && grant.projectId === null) return true;

  if (projectId !== null) {
    if (grant.projectId === projectId) return true;
    if (grant.projectId === null && grant.orgId === orgId) return true;
    return false;
  }

  if (orgId !== null) {
    return grant.orgId === orgId;
  }

  return false;
}

export function collectPermissions(grants: Grant[], scope: AuthScope): Set<Permission> {
  const orgId = scope.orgId ?? null;
  const projectId = scope.projectId ?? null;
  const out = new Set<Permission>();
  for (const grant of grants) {
    if (isGrantApplicable(grant, orgId, projectId)) {
      for (const permission of grant.permissions) out.add(permission);
    }
  }
  return out;
}

export function authorize(
  user: AppPolicyUser,
  permission: Permission,
  scope: AuthScope
): boolean {
  return collectPermissions(user.grants, scope).has(permission);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- authorize`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/permissions/authorize.ts src/lib/services/permissions/authorize.test.ts
git commit -m "feat(rbac): scope-based authorize() engine with unit tests"
```

### Task 6: Load a user's grants from the DB (TDD)

**Files:**
- Create: `src/domains/user-roles/user-roles.repository.ts`
- Test: `src/domains/user-roles/user-roles.repository.test.ts`

- [ ] **Step 1: Write the failing test (grouping logic)**

The DB query is integration-tested in Phase 4; here we unit-test the row→`Grant[]` grouping via an exported pure helper.

```ts
import { describe, expect, it } from 'vitest';

import { groupGrantRows } from './user-roles.repository';

describe('groupGrantRows', () => {
  it('groups permission rows by (orgId, projectId)', () => {
    const rows = [
      { orgId: 1, projectId: null, permission: 'project:view' },
      { orgId: 1, projectId: null, permission: 'project:create' },
      { orgId: 1, projectId: 10, permission: 'content:update' },
      { orgId: null, projectId: null, permission: 'project:delete' },
    ];
    const grants = groupGrantRows(rows);
    expect(grants).toHaveLength(3);
    const orgWide = grants.find((g) => g.orgId === 1 && g.projectId === null)!;
    expect([...orgWide.permissions].sort()).toEqual(['project:create', 'project:view']);
    const pinned = grants.find((g) => g.projectId === 10)!;
    expect([...pinned.permissions]).toEqual(['content:update']);
    const global = grants.find((g) => g.orgId === null && g.projectId === null)!;
    expect([...global.permissions]).toEqual(['project:delete']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- user-roles.repository`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement repository + helper**

```ts
import { eq } from 'drizzle-orm';

import type { Permission } from '@/lib/permissions';
import type { Grant, Result } from '@/lib/types';

import { db } from '@/db';
import { permissions, role_permissions, user_roles } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

export interface GrantRow {
  orgId: number | null;
  projectId: number | null;
  permission: string;
}

const key = (orgId: number | null, projectId: number | null): string =>
  `${orgId ?? 'null'}:${projectId ?? 'null'}`;

/** Pure: fold flat (scope, permission) rows into one Grant per distinct scope. */
export function groupGrantRows(rows: GrantRow[]): Grant[] {
  const byScope = new Map<string, { orgId: number | null; projectId: number | null; permissions: Set<Permission> }>();
  for (const row of rows) {
    const k = key(row.orgId, row.projectId);
    let entry = byScope.get(k);
    if (!entry) {
      entry = { orgId: row.orgId, projectId: row.projectId, permissions: new Set<Permission>() };
      byScope.set(k, entry);
    }
    entry.permissions.add(row.permission as Permission);
  }
  return [...byScope.values()];
}

export async function findGrantsByUserId(userId: number): Promise<Result<Grant[]>> {
  try {
    const rows = await db
      .select({
        orgId: user_roles.orgId,
        projectId: user_roles.projectId,
        permission: permissions.name,
      })
      .from(user_roles)
      .innerJoin(role_permissions, eq(role_permissions.roleId, user_roles.roleId))
      .innerJoin(permissions, eq(permissions.id, role_permissions.permissionId))
      .where(eq(user_roles.userId, userId));
    return ok(groupGrantRows(rows));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to load grants', context: { userId } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- user-roles.repository`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domains/user-roles/
git commit -m "feat(rbac): load and group user grants from user_roles"
```

### Task 7: Grant mutation service (create / revoke)

**Files:**
- Create: `src/domains/user-roles/user-roles.service.ts`

- [ ] **Step 1: Implement (used by migration + invitation; thin wrapper)**

```ts
import { and, eq, isNull } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { user_roles } from '@/db/schema';
import { handleConstraintError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

export interface GrantInput {
  userId: number;
  orgId: number | null;
  projectId: number | null;
  roleId: number;
  createdBy?: number | null;
}

export async function grantRole(input: GrantInput): Promise<Result<void>> {
  try {
    await db.insert(user_roles).values(input).onConflictDoNothing();
    return ok(undefined);
  } catch (error) {
    return handleConstraintError(error);
  }
}

/** Revoke a single (user, org, project, role) grant. Null scope values match NULL columns. */
export async function revokeRole(input: GrantInput): Promise<Result<void>> {
  try {
    await db
      .delete(user_roles)
      .where(
        and(
          eq(user_roles.userId, input.userId),
          input.orgId === null ? isNull(user_roles.orgId) : eq(user_roles.orgId, input.orgId),
          input.projectId === null
            ? isNull(user_roles.projectId)
            : eq(user_roles.projectId, input.projectId),
          eq(user_roles.roleId, input.roleId)
        )
      );
    return ok(undefined);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to revoke role', context: input });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
```

- [ ] **Step 2: Typecheck this file in isolation**

Run: `npx tsc --noEmit src/domains/user-roles/user-roles.service.ts 2>&1 | head` (informational; full typecheck is red until Phase 3 ends).

- [ ] **Step 3: Commit**

```bash
git add src/domains/user-roles/user-roles.service.ts
git commit -m "feat(rbac): grant/revoke role mutations"
```

---

## Phase 2 — Wire grants into the request lifecycle

### Task 8: Rework the context `User` type and load grants at authentication

**Files:**
- Modify: `src/lib/types.ts:9-17` (context `User` interface)
- Modify: `src/middlewares/authenticate.ts:122-130`

- [ ] **Step 1: Replace the context `User` interface**

```ts
import type { Grant } from '@/lib/types'; // (already in this file; keep single definition)

export interface User {
  id: number;
  email: string;
  status: 'invited' | 'verified' | 'inactive';
  grants: Grant[];
  [key: string]: any;
}
```

Remove `role`, `roleName`, `organization` from this interface (they are no longer part of identity).

- [ ] **Step 2: Load grants in `authenticate` after resolving the app user**

Replace the block at `authenticate.ts:122-130`:

```ts
    // Look up the application user and load their grants
    const userResult = await getUserByEmail(session.user.email);
    if (userResult.ok) {
      const grantsResult = await findGrantsByUserId(userResult.data.id);
      c.set('user', {
        ...userResult.data,
        grants: grantsResult.ok ? grantsResult.data : [],
      });
    } else {
      logger.debug('Authenticated auth_user has no linked application user', {
        email: session.user.email,
      });
    }
```

Add import at top of `authenticate.ts`:

```ts
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts src/middlewares/authenticate.ts
git commit -m "feat(rbac): attach resolved grants to the request user"
```

### Task 9: `requirePermission(permission, scopeFn)` and self-access

**Files:**
- Modify: `src/middlewares/role-auth.ts`
- Modify: `src/lib/services/permissions/permissions.service.ts`

- [ ] **Step 1: Replace `permissions.service.ts` with a re-export of the engine**

```ts
export { authorize, collectPermissions } from './authorize';
```

(Delete `roleHasPermission`; Task 9 Step 2 removes its only caller.)

- [ ] **Step 2: Rewrite `requirePermission` to be scope-aware**

Replace the `requirePermission` function in `role-auth.ts`:

```ts
import type { AuthScope } from '@/lib/types';

import { authorize } from '@/lib/services/permissions/authorize';

/** Extracts the scope an action is evaluated against from the request context. */
export type ScopeResolver = (c: Context<AppBindings>) => AuthScope | Promise<AuthScope>;

export function requirePermission(permission: Permission, resolveScope?: ScopeResolver) {
  return async (c: Context<AppBindings>, next: Next) => {
    const user = c.get('user');
    if (!user) {
      throw new HTTPException(HttpStatusCodes.UNAUTHORIZED, { message: 'User not authenticated' });
    }

    const scope: AuthScope = resolveScope ? await resolveScope(c) : {};
    const policyUser = { id: user.id, grants: user.grants };

    if (!authorize(policyUser, permission, scope)) {
      throw new HTTPException(HttpStatusCodes.FORBIDDEN, { message: 'Insufficient permissions' });
    }
    await next();
  };
}
```

Leave `authenticateUser` and `requireSelf` as-is except: `requireSelf` already only uses `user.id`, so no change.

- [ ] **Step 3: Add reusable scope resolvers**

Append to `role-auth.ts`:

```ts
/** Scope from a numeric `organization` field in the JSON body. */
export const orgFromBody: ScopeResolver = async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const orgId = Number(body?.organization);
  return Number.isFinite(orgId) ? { orgId } : {};
};
```

(Project-scoped resolvers live in each domain's auth middleware, which already loads the resource — see Phase 3.)

- [ ] **Step 4: Commit**

```bash
git add src/middlewares/role-auth.ts src/lib/services/permissions/permissions.service.ts
git commit -m "feat(rbac): scope-aware requirePermission; retire roleHasPermission"
```

---

## Phase 3 — Switch over policies, middleware, and routes (ends green)

> These tasks are tightly coupled — they collectively fix every typecheck error introduced in Task 4/8. Run `npm run typecheck` at the **end of Task 15**; expect green there.

### Task 10: Rewrite `project.policy.ts`

**Files:**
- Modify: `src/domains/projects/project.policy.ts`
- Modify: `src/domains/projects/projects.types.ts` (ensure `ProjectWithLanguageNames` exposes `id` and `organization`)

- [ ] **Step 1: Replace the policy body**

```ts
import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { authorize } from '@/lib/services/permissions/authorize';

import type { ProjectWithLanguageNames } from './projects.types';

export const ProjectPolicy = {
  /** Can list projects at all? Anyone with project:view in any scope. */
  list(user: AppPolicyUser): boolean {
    return user.grants.some((g) => g.permissions.has(PERMISSIONS.PROJECT_VIEW));
  },

  read(
    user: AppPolicyUser,
    project: ProjectWithLanguageNames,
    isAssignedToProject = false
  ): boolean {
    const scope = { orgId: project.organization, projectId: project.id };
    if (authorize(user, PERMISSIONS.PROJECT_VIEW, scope)) return true;
    // Translators with no org/project-wide view still see projects they're assigned to.
    return isAssignedToProject;
  },

  update(user: AppPolicyUser, project: ProjectWithLanguageNames): boolean {
    return authorize(user, PERMISSIONS.PROJECT_UPDATE, {
      orgId: project.organization,
      projectId: project.id,
    });
  },

  delete(user: AppPolicyUser, project: ProjectWithLanguageNames): boolean {
    return authorize(user, PERMISSIONS.PROJECT_DELETE, {
      orgId: project.organization,
      projectId: project.id,
    });
  },
};
```

- [ ] **Step 2: Commit** (build still red until Task 15)

```bash
git add src/domains/projects/project.policy.ts src/domains/projects/projects.types.ts
git commit -m "refactor(rbac): project policy uses authorize()"
```

### Task 11: Rewrite project auth middleware, route handlers, and project listing/creation

**Files:**
- Modify: `src/domains/projects/project-auth.middleware.ts`
- Modify: `src/domains/projects/projects.route.ts:57-108`
- Modify: `src/domains/projects/projects.service.ts` (add `getProjectsForUser`)
- Modify: `src/domains/projects/projects.repository.ts` (add multi-scope project fetch)
- Modify: `src/domains/projects/projects.types.ts` (add `organization` to `createProjectWithUnitsSchema`)

- [ ] **Step 1: Simplify `policyUser` construction in `project-auth.middleware.ts`**

Replace the `policyUser` literal (lines 19-24) with:

```ts
    const policyUser = { id: user.id, grants: user.grants };
```

`resolveIsProjectMember(projectId, user.id)` loses its `roleName` arg (see Task 14). Update the two call sites in this file accordingly.

- [ ] **Step 2: `GET /projects` returns the union of projects the user can access**

Add to `projects.service.ts`:

```ts
import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { collectPermissions } from '@/lib/services/permissions/authorize';

/**
 * Org IDs where the user holds project:view org-wide (project_id null),
 * and project IDs where they hold a project-pinned view grant.
 */
export async function getProjectsForUser(user: AppPolicyUser): Promise<Result<ProjectWithLanguageNames[]>> {
  const orgIds = new Set<number>();
  const projectIds = new Set<number>();
  for (const g of user.grants) {
    if (!g.permissions.has(PERMISSIONS.PROJECT_VIEW)) continue;
    if (g.projectId !== null) projectIds.add(g.projectId);
    else if (g.orgId !== null) orgIds.add(g.orgId);
  }
  return repo.findByOrgIdsOrProjectIds([...orgIds], [...projectIds]);
}
```

Add to `projects.repository.ts` (mirror the existing `findByOrganization` join, line ~63):

```ts
import { inArray, or } from 'drizzle-orm';

export async function findByOrgIdsOrProjectIds(
  orgIds: number[],
  projectIds: number[]
): Promise<Result<ProjectWithLanguageNames[]>> {
  if (orgIds.length === 0 && projectIds.length === 0) return ok([]);
  try {
    const conditions = [];
    if (orgIds.length) conditions.push(inArray(projects.organization, orgIds));
    if (projectIds.length) conditions.push(inArray(projects.id, projectIds));
    const rows = await baseJoinQuery().where(or(...conditions));
    return ok(rows);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to find projects for user' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
```

Replace the `GET /projects` handler (`projects.route.ts:57-63`):

```ts
server.openapi(listProjectsRoute, async (c) => {
  const currentUser = c.get('user')!;
  const result = await projectService.getProjectsForUser({
    id: currentUser.id,
    grants: currentUser.grants,
  });
  if (result.ok) return c.json(result.data, HttpStatusCodes.OK);
  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
```

- [ ] **Step 3: `POST /projects` takes `organization` from the body, scope-checked**

In `projects.types.ts`, add `organization: z.number().int()` to `createProjectWithUnitsSchema`.

In `projects.route.ts`, change the create route middleware to resolve scope from the body:

```ts
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_CREATE, orgFromBody),
  ] as const,
```

Add `import { orgFromBody } from '@/middlewares/role-auth';` and update the handler (`:96-108`) to use `projectData.organization` instead of `currentUser.organization`:

```ts
  const result = await projectService.createProject({
    ...projectData,
    createdBy: currentUser.id,
    organization: projectData.organization,
  });
```

After a project is created, grant the creator a project-pinned PM role (so they manage what they create):

```ts
  if (result.ok) {
    await grantRole({
      userId: currentUser.id,
      orgId: projectData.organization,
      projectId: result.data.id,
      roleId: await getRoleId(ROLES.PROJECT_MANAGER),
      createdBy: currentUser.id,
    });
    return c.json(result.data, HttpStatusCodes.CREATED);
  }
```

Add a small cached `getRoleId(name)` helper in `user-roles.service.ts`:

```ts
import { roles } from '@/db/schema';

const roleIdCache = new Map<string, number>();
export async function getRoleId(name: string): Promise<number> {
  const cached = roleIdCache.get(name);
  if (cached) return cached;
  const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1);
  if (!row) throw new Error(`Role not found: ${name}`);
  roleIdCache.set(name, row.id);
  return row.id;
}
```

Imports in `projects.route.ts`: `import { grantRole, getRoleId } from '@/domains/user-roles/user-roles.service';` and `import { ROLES } from '@/lib/roles';`.

- [ ] **Step 4: Commit**

```bash
git add src/domains/projects/
git commit -m "refactor(rbac): project routes resolve org/project scope from grants"
```

### Task 12: Rewrite `chapter-assignments.policy.ts` + auth middleware

**Files:**
- Modify: `src/domains/chapter-assignments/chapter-assignments.policy.ts`
- Modify: `src/domains/chapter-assignments/chapter-assignment-auth.middleware.ts`

- [ ] **Step 1: Replace org/role checks with `authorize`, preserving status logic**

Every `user.organization !== assignment.organizationId` guard and `user.roleName === ROLES.PROJECT_MANAGER` check is replaced by permission checks scoped to `{ orgId: assignment.organizationId, projectId: assignment.projectId }`. The policy now needs `projectId` on `PolicyChapterAssignment`.

Add `projectId: number;` to `PolicyChapterAssignment` (the repository already selects `projects.id` — expose it; see Step 2). Rewrite each method, e.g.:

```ts
import { PERMISSIONS } from '@/lib/permissions';
import { authorize } from '@/lib/services/permissions/authorize';

export interface PolicyChapterAssignment {
  organizationId: number;
  projectId: number;
  assignedUserId?: number | null;
  peerCheckerId?: number | null;
  status?: string | null;
}

const POST_PEER_STATUSES = new Set<string>([
  CHAPTER_ASSIGNMENT_STATUS.COMMUNITY_REVIEW,
  CHAPTER_ASSIGNMENT_STATUS.LINGUIST_CHECK,
  CHAPTER_ASSIGNMENT_STATUS.THEOLOGICAL_CHECK,
  CHAPTER_ASSIGNMENT_STATUS.CONSULTANT_CHECK,
]);

export const ChapterAssignmentPolicy = {
  edit(user, assignment, isProjectMember): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };
    // Managers (content:assign) may edit only at/after community review.
    if (authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope)) {
      return POST_PEER_STATUSES.has(assignment.status ?? '');
    }
    // Content editors (translators) — assignment-position rules.
    if (!authorize(user, PERMISSIONS.CONTENT_UPDATE, scope)) return false;
    switch (assignment.status) {
      case CHAPTER_ASSIGNMENT_STATUS.DRAFT:
        return assignment.assignedUserId === user.id;
      case CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK:
        return assignment.peerCheckerId === user.id;
      default:
        return POST_PEER_STATUSES.has(assignment.status ?? '') && isProjectMember;
    }
  },

  viewAll(user, targetOrganizationId): boolean {
    return authorize(user, PERMISSIONS.CONTENT_VIEW, { orgId: targetOrganizationId });
  },

  view(user, assignment): boolean {
    return authorize(user, PERMISSIONS.CONTENT_VIEW, {
      orgId: assignment.organizationId,
      projectId: assignment.projectId,
    });
  },

  create(user, project): boolean {
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, {
      orgId: project.organizationId,
      projectId: project.projectId,
    });
  },

  update(user, assignment): boolean {
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, {
      orgId: assignment.organizationId,
      projectId: assignment.projectId,
    });
  },

  delete(user, assignment): boolean {
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, {
      orgId: assignment.organizationId,
      projectId: assignment.projectId,
    });
  },

  deleteAll(user, scope): boolean {
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope);
  },

  assignAll(user, scope): boolean {
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope);
  },

  _assign(user, assignment): boolean {
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, {
      orgId: assignment.organizationId,
      projectId: assignment.projectId,
    });
  },

  assignDrafter(user, assignment): boolean { return this._assign(user, assignment); },
  assignPeerChecker(user, assignment): boolean { return this._assign(user, assignment); },

  submit(user, assignment, isProjectMember): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };
    if (authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope)) {
      return POST_PEER_STATUSES.has(assignment.status ?? '');
    }
    if (!authorize(user, PERMISSIONS.CONTENT_UPDATE, scope)) return false;
    switch (assignment.status) {
      case CHAPTER_ASSIGNMENT_STATUS.DRAFT:
        return assignment.assignedUserId === user.id;
      case CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK:
        return assignment.peerCheckerId === user.id;
      default:
        return POST_PEER_STATUSES.has(assignment.status ?? '') && isProjectMember;
    }
  },

  isParticipant(user, assignment): boolean {
    if (!authorize(user, PERMISSIONS.CONTENT_UPDATE, {
      orgId: assignment.organizationId,
      projectId: assignment.projectId,
    })) return false;
    return assignment.assignedUserId === user.id || assignment.peerCheckerId === user.id;
  },
};
```

Type the params explicitly (`user: AppPolicyUser`, `assignment: PolicyChapterAssignment`, `scope: AuthScope`) to satisfy strict mode.

Behavior note preserved: the seed (Task 16) grants `content:assign` to PM/Owner/Manager and `content:update` to translators — so `CONTENT_ASSIGN` cleanly distinguishes "manager" from "translator" without naming roles. `create`/`viewAll` take a `{ organizationId, projectId }` shape — update the two callers in the route (Task 13) to pass it.

- [ ] **Step 2: Update the auth middleware**

In `chapter-assignment-auth.middleware.ts`: build `policyUser = { id: user.id, grants: user.grants }`; add `projectId: ctx.projectId` to `policyAssignment`; replace the `READ` branch's role/org check with `ChapterAssignmentPolicy.view(policyUser, policyAssignment) || ctx.isProjectMember`. Drop the `user.roleName` argument from `getChapterAssignmentWithAuthContext` (Task 14). Ensure the repository's `ChapterAssignmentWithAuthContext` includes `projectId` (it already selects `projects.organization`; add `projectId: projects.id`).

- [ ] **Step 3: Commit**

```bash
git add src/domains/chapter-assignments/
git commit -m "refactor(rbac): chapter-assignment policy/middleware use authorize()"
```

### Task 13: Update project-scoped chapter-assignment route & service

**Files:**
- Modify: `src/domains/projects/chapter-assignments/project-chapter-assignments.route.ts:108-290`
- Modify: `src/domains/projects/chapter-assignments/project-chapter-assignments.service.ts:60-140`

- [ ] **Step 1: Replace `currentUser.organization` policy calls with the project's scope**

Each `policyUser = { id, roleName, organization }` becomes `{ id: currentUser.id, grants: currentUser.grants }`. Each `ChapterAssignmentPolicy.deleteAll/assignAll(policyUser, project.organization)` becomes `(policyUser, { orgId: project.organization, projectId: project.id })`.

- [ ] **Step 2: Replace org-membership validation in the service**

In `project-chapter-assignments.service.ts`, the checks `u.organization !== projectOrgId` / `u.organization === projectOrgId` (lines 76, 136) validated that assignees belong to the project's org. Replace with a membership check against `user_roles`: a candidate user is valid iff they hold any grant with `org_id = projectOrgId`. Add to `user-roles.repository.ts`:

```ts
export async function findUserIdsInOrg(orgId: number, userIds: number[]): Promise<Set<number>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ userId: user_roles.userId })
    .from(user_roles)
    .where(and(eq(user_roles.orgId, orgId), inArray(user_roles.userId, userIds)));
  return new Set(rows.map((r) => r.userId));
}
```

Use it to compute `invalidUsers` / the filtered set. Import `and, inArray` from `drizzle-orm`.

- [ ] **Step 3: Commit**

```bash
git add src/domains/projects/chapter-assignments/
git commit -m "refactor(rbac): project chapter-assignment routes use grant-based scope"
```

### Task 14: `resolveIsProjectMember` + translated-verse middleware

**Files:**
- Modify: `src/domains/projects/users/project-users.service.ts`
- Modify: `src/domains/translated-verses/translated-verse-auth.middleware.ts`
- Modify: `src/domains/chapter-assignments/chapter-assignments.repository.ts` (drop `roleName` param, add `projectId`)

- [ ] **Step 1: `resolveIsProjectMember` derives membership from `user_roles`**

```ts
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { user_roles } from '@/db/schema';

/** A user is a project member iff they hold any grant pinned to that project,
 *  or any org-wide grant over that project's org. */
export async function resolveIsProjectMember(projectId: number, userId: number): Promise<boolean> {
  const [pinned] = await db
    .select({ id: user_roles.id })
    .from(user_roles)
    .where(and(eq(user_roles.userId, userId), eq(user_roles.projectId, projectId)))
    .limit(1);
  if (pinned) return true;
  // org-wide membership over the project's org
  const rows = await db
    .select({ id: user_roles.id })
    .from(user_roles)
    .innerJoin(projects, eq(projects.id, projectId))
    .where(and(eq(user_roles.userId, userId), eq(user_roles.orgId, projects.organization)))
    .limit(1);
  return rows.length > 0;
}
```

Import `projects` from `@/db/schema`.

- [ ] **Step 2: Update all `resolveIsProjectMember(projectId, userId, roleName)` call sites**

Remove the third argument everywhere (project-auth.middleware ×1, translated-verse-auth.middleware ×2). Update `policyUser` literals in `translated-verse-auth.middleware.ts` to `{ id: user.id, grants: user.grants }`.

- [ ] **Step 3: Drop `roleName` from chapter-assignment repository/service signatures**

`getChapterAssignmentWithAuthContext(id, userId)` and `chapter-assignments.repository.ts` member-resolution no longer take `roleName`; they use `resolveIsProjectMember`. Add `projectId: projects.id` to the selected `ChapterAssignmentWithAuthContext`.

- [ ] **Step 4: Commit**

```bash
git add src/domains/projects/users/ src/domains/translated-verses/ src/domains/chapter-assignments/
git commit -m "refactor(rbac): project membership derived from user_roles"
```

### Task 15: Users domain — policy, middleware, listing, invitation; restore green

**Files:**
- Modify: `src/domains/users/user.policy.ts`
- Modify: `src/domains/users/user-auth.middleware.ts`
- Modify: `src/domains/users/users.service.ts` + `users.repository.ts` (replace `findByOrganization`/`findByEmail`)
- Modify: `src/domains/users/users.types.ts` (`userResponseSchema`: drop `role`/`organization`)
- Modify: `src/lib/services/auth/auth.service.ts` (invitation creates a grant)
- Modify: `src/db/seeds/dev-users.ts` (seed via grants — align with new schema)

- [ ] **Step 1: Rewrite `user.policy.ts` against `authorize`**

A user is viewable/updatable by an actor who shares an org with them (actor holds `user:view`/`user:update` in that org) or is SuperAdmin; self-access always allowed for view/update.

```ts
import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { authorize } from '@/lib/services/permissions/authorize';

export const UserPolicy = {
  list(user: AppPolicyUser): boolean {
    return user.grants.some((g) => g.permissions.has(PERMISSIONS.USER_VIEW));
  },
  create(user: AppPolicyUser): boolean {
    return user.grants.some((g) => g.permissions.has(PERMISSIONS.USER_CREATE));
  },
  view(user: AppPolicyUser, target: { id: number; orgIds: number[] }): boolean {
    if (user.id === target.id) return true;
    return target.orgIds.some((orgId) => authorize(user, PERMISSIONS.USER_VIEW, { orgId }));
  },
  update(user: AppPolicyUser, target: { id: number; orgIds: number[] }): boolean {
    if (user.id === target.id) return true;
    return target.orgIds.some((orgId) => authorize(user, PERMISSIONS.USER_UPDATE, { orgId }));
  },
  delete(user: AppPolicyUser, target: { id: number; orgIds: number[] }): boolean {
    // Full account deletion is SuperAdmin-only (no role is seeded user:delete). Deferred otherwise.
    return target.orgIds.some((orgId) => authorize(user, PERMISSIONS.USER_DELETE, { orgId }));
  },
};
```

Add `findOrgIdsForUser(userId)` to `user-roles.repository.ts`:

```ts
export async function findOrgIdsForUser(userId: number): Promise<number[]> {
  const rows = await db
    .selectDistinct({ orgId: user_roles.orgId })
    .from(user_roles)
    .where(eq(user_roles.userId, userId));
  return rows.map((r) => r.orgId).filter((x): x is number => x !== null);
}
```

`user-auth.middleware.ts`: `policyUser = { id: user.id, grants: user.grants }`; for VIEW/UPDATE/DELETE load `target.orgIds = await findOrgIdsForUser(targetUserId)` and pass `{ id: targetUserId, orgIds }`.

- [ ] **Step 2: Replace `users.repository.findByEmail` (no more role join)**

```ts
export async function findByEmail(email: string): Promise<Result<User>> {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    if (!user) return err(ErrorCode.USER_NOT_FOUND);
    return ok(user);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to find user by email', context: { email } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
```

Delete `findByOrganization`; replace its callers (`getUsersByOrganization`) with a grant-org-based listing: `getUsersInOrg(orgId)` joining `user_roles`. Remove `role`/`organization`/`roleName` from `toUserResponse`, `userResponseSchema`, `User`/`UserResponse`, and the create/update request schemas (`users.types.ts`). The `UserWithRole` type is deleted.

- [ ] **Step 3: Invitation creates the initial grant**

`createUserWithInvitation` (and `users.types.CreateUserInput`) now carry `orgId`, `projectId?`, and `roleId` for the grant instead of `role`/`organization` columns. After `createUserWithAuth` succeeds, call `grantRole({ userId, orgId, projectId, roleId, createdBy })`. A PM inviting to their project passes `{ orgId: project.org, projectId: project.id, roleId: PROJECT_MANAGER|PROJECT_TRANSLATOR }` (validated by `requirePermission(USER_CREATE, projectScope)` + `role:assign:project`). Update `createUserWithAuth`/`insert` to stop writing `role`/`organization`.

- [ ] **Step 4: Typecheck — must be green now**

Run: `npm run typecheck`
Expected: PASS. If any `user.organization`/`user.roleName`/`ROLES.TRANSLATOR` references remain, fix them (grep: `grep -rn "\.organization\b\|\.roleName\b\|ROLES.TRANSLATOR" src --include='*.ts' | grep -v test`).

- [ ] **Step 5: Run the full suite; fix broken existing tests**

Run: `npm test`
Expected: existing policy/middleware tests reference the old `{ roleName, organization }` user shape and the old role strings — update their fixtures to `{ id, grants: [...] }` using the `grant()` helper pattern from Task 5, and update `src/test/utils/test-helpers.ts` `sampleUsers` to drop `role`/`organization` and add `grants`. Iterate until green.

- [ ] **Step 6: Commit**

```bash
git add src/domains/users/ src/lib/services/auth/auth.service.ts src/db/seeds/dev-users.ts src/test/
git commit -m "refactor(rbac): users domain + invitation use grants; build green"
```

---

## Phase 4 — Seeds, data migration, teardown

### Task 16: Seed the new roles and permission map

**Files:**
- Modify: `src/db/seeds/roles.ts`
- Modify: `src/db/seeds/rbac.ts`

- [ ] **Step 1: Seed every role name**

`roles.ts` inserts all six `ROLES` values (`onConflictDoNothing` on `roles.name`).

- [ ] **Step 2: Rewrite `ROLE_PERMISSION_MAP` per the spec**

```ts
const PERMISSION_DEFINITIONS = [
  { name: PERMISSIONS.PROJECT_VIEW, description: 'View projects' },
  { name: PERMISSIONS.PROJECT_CREATE, description: 'Create new projects' },
  { name: PERMISSIONS.PROJECT_UPDATE, description: 'Update existing projects' },
  { name: PERMISSIONS.PROJECT_DELETE, description: 'Delete projects' },
  { name: PERMISSIONS.CONTENT_VIEW, description: 'View content' },
  { name: PERMISSIONS.CONTENT_ASSIGN, description: 'Assign chapter assignment' },
  { name: PERMISSIONS.CONTENT_UPDATE, description: 'Update chapter assignment content' },
  { name: PERMISSIONS.USER_VIEW, description: 'View user profiles' },
  { name: PERMISSIONS.USER_CREATE, description: 'Create/invite users' },
  { name: PERMISSIONS.USER_UPDATE, description: 'Update user profiles' },
  { name: PERMISSIONS.USER_DELETE, description: 'Delete a user account (SuperAdmin only)' },
  { name: PERMISSIONS.MEMBERSHIP_REVOKE, description: 'Disassociate a user from a scope' },
  { name: PERMISSIONS.ROLE_ASSIGN_PROJECT, description: 'Assign project-tier roles' },
  { name: PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER, description: 'Assign Org Manager role' },
];

const ALL = PERMISSION_DEFINITIONS.map((p) => p.name);
const PROJECT_MANAGER_PERMS = [
  PERMISSIONS.PROJECT_VIEW, PERMISSIONS.PROJECT_CREATE, PERMISSIONS.PROJECT_UPDATE, PERMISSIONS.PROJECT_DELETE,
  PERMISSIONS.CONTENT_VIEW, PERMISSIONS.CONTENT_ASSIGN, PERMISSIONS.CONTENT_UPDATE,
  PERMISSIONS.USER_VIEW, PERMISSIONS.USER_CREATE, PERMISSIONS.USER_UPDATE,
  PERMISSIONS.MEMBERSHIP_REVOKE, PERMISSIONS.ROLE_ASSIGN_PROJECT,
];
const ORG_MANAGER_PERMS = PROJECT_MANAGER_PERMS;
const ORG_OWNER_PERMS = [...ORG_MANAGER_PERMS, PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER];
const TRANSLATOR_PERMS = [PERMISSIONS.PROJECT_VIEW, PERMISSIONS.CONTENT_VIEW, PERMISSIONS.CONTENT_UPDATE, PERMISSIONS.USER_VIEW, PERMISSIONS.USER_UPDATE];
const OBSERVER_PERMS = [PERMISSIONS.PROJECT_VIEW, PERMISSIONS.CONTENT_VIEW];

const ROLE_PERMISSION_MAP = [
  ...ALL.map((p) => ({ roleName: ROLES.SUPER_ADMIN, permissionName: p })),
  ...ORG_OWNER_PERMS.map((p) => ({ roleName: ROLES.ORG_OWNER, permissionName: p })),
  ...ORG_MANAGER_PERMS.map((p) => ({ roleName: ROLES.ORG_MANAGER, permissionName: p })),
  ...PROJECT_MANAGER_PERMS.map((p) => ({ roleName: ROLES.PROJECT_MANAGER, permissionName: p })),
  ...TRANSLATOR_PERMS.map((p) => ({ roleName: ROLES.PROJECT_TRANSLATOR, permissionName: p })),
  ...OBSERVER_PERMS.map((p) => ({ roleName: ROLES.PROJECT_OBSERVER, permissionName: p })),
];
```

(Note: `USER_DELETE` is granted only to SuperAdmin via the `ALL` spread — deferring account deletion.)

- [ ] **Step 3: Run seeds against a clean test DB; assert no throw**

Run: `npm run db:seed:roles && npm run db:seed:rbac`
Expected: "RBAC seeded." with no "Role/Permission not found" errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/seeds/roles.ts src/db/seeds/rbac.ts
git commit -m "feat(rbac): seed full role set and permission map"
```

### Task 17: Data migration script (TDD against a fixture DB)

**Files:**
- Create: `src/db/scripts/migrate-to-user-central-rbac.ts`
- Test: `src/db/scripts/migrate-to-user-central-rbac.test.ts`

- [ ] **Step 1: Write the failing integration test**

Seed a fixture (against the test DB) with: roles `Manager`/`Translator` (old names) renamed to new ones by the script; one org; one Manager user; one Translator user with a `project_users` row. Then run `migrateToUserCentralRbac()` and assert:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
// ... import db, schema, seed helpers, migrateToUserCentralRbac

describe('migrate-to-user-central-rbac', () => {
  it('maps Manager -> org-wide Project Manager grant', async () => {
    // arrange: org O, project P in O, manager M (users.role=Manager, users.organization=O)
    await migrateToUserCentralRbac();
    // assert: user_roles has (M, O, null, ProjectManager) and no project-pinned row
  });

  it('maps Translator -> project-pinned Project Translator per project_users row', async () => {
    // arrange: translator T in project P (project_users), users.organization=O
    await migrateToUserCentralRbac();
    // assert: user_roles has (T, O, P, ProjectTranslator)
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- migrate-to-user-central-rbac`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the migration (transactional)**

```ts
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { project_users, projects, roles, user_roles, users } from '@/db/schema';
import { ROLES } from '@/lib/roles';

export async function migrateToUserCentralRbac(): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Rename legacy role rows so name FKs line up with the new constants.
    await tx.update(roles).set({ name: ROLES.PROJECT_MANAGER }).where(eq(roles.name, 'Manager'));
    await tx.update(roles).set({ name: ROLES.PROJECT_TRANSLATOR }).where(eq(roles.name, 'Translator'));

    const roleRows = await tx.select({ id: roles.id, name: roles.name }).from(roles);
    const roleId = new Map(roleRows.map((r) => [r.name, r.id]));
    const pmId = roleId.get(ROLES.PROJECT_MANAGER)!;
    const ptId = roleId.get(ROLES.PROJECT_TRANSLATOR)!;

    const allUsers = await tx
      .select({ id: users.id, organization: users.organization, role: users.role })
      .from(users);

    for (const u of allUsers) {
      if (u.role === pmId) {
        // Manager -> org-wide PM grant
        await tx
          .insert(user_roles)
          .values({ userId: u.id, orgId: u.organization, projectId: null, roleId: pmId })
          .onConflictDoNothing();
      } else if (u.role === ptId) {
        // Translator -> project-pinned PT grant per project_users row
        const memberships = await tx
          .select({ projectId: project_users.projectId })
          .from(project_users)
          .where(eq(project_users.userId, u.id));
        for (const m of memberships) {
          await tx
            .insert(user_roles)
            .values({ userId: u.id, orgId: u.organization, projectId: m.projectId, roleId: ptId })
            .onConflictDoNothing();
        }
      }
    }

    // 3. Verify: every migrated user has at least one grant.
    const granted = await tx.selectDistinct({ userId: user_roles.userId }).from(user_roles);
    const grantedIds = new Set(granted.map((g) => g.userId));
    const orphans = allUsers.filter((u) => !grantedIds.has(u.id)).map((u) => u.id);
    if (orphans.length) {
      throw new Error(`Migration left users without grants: ${orphans.join(', ')}`);
    }
  });
  console.log('User-central RBAC migration complete.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrateToUserCentralRbac()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
```

Add `"db:migrate-rbac": "npx tsx src/db/scripts/migrate-to-user-central-rbac.ts"` to `package.json` scripts.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- migrate-to-user-central-rbac`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/scripts/migrate-to-user-central-rbac.ts src/db/scripts/migrate-to-user-central-rbac.test.ts package.json
git commit -m "feat(rbac): one-shot data migration to user-central grants"
```

### Task 18: Drop legacy columns and `project_users`

> Run only AFTER the data migration (Task 17) has executed against each environment. The schema drop and the data migration are deployed together: seed roles/permissions → `db:migrate-rbac` → `db:migrate` (the drop).

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Remove `users.organization` and `users.role`**

Delete those two columns from the `users` table definition and from `insertUsersSchema`'s `.required(...)`/related schemas.

- [ ] **Step 2: Remove the `project_users` table + its schemas**

Delete the `project_users` `pgTable`, `selectProjectUsersSchema`, `insertProjectUsersSchema`, `patchProjectUsersSchema`. Confirm no remaining importers: `grep -rn "project_users\|ProjectUsersSchema" src --include='*.ts'` → only the (now-deleted) lines.

- [ ] **Step 3: Generate + inspect the drop migration**

Run: `npm run db:generate -- drop_legacy_rbac_columns`
Expected: a migration dropping `users.organization`, `users.role`, and the `project_users` table. Verify it does not touch `user_roles`.

- [ ] **Step 4: Apply and run full gate**

Run: `npm run db:migrate && npm run precheck`
Expected: PASS (lint + format + typecheck + all tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/migrations/
git commit -m "feat(rbac)!: drop users.organization, users.role, project_users"
```

### Task 19: Integration sweep — multi-org user

**Files:**
- Test: `src/middlewares/authenticate.test.ts` (extend) or a new `src/test/rbac-integration.test.ts`

- [ ] **Step 1: Write an end-to-end test for a user who is PM in org A and Translator in org B**

Seed: user U; grant `(U, A, null, ProjectManager)` and `(U, B, projB, ProjectTranslator)`. Assert via the route handlers / policies that U can update a project in A, cannot update a project in B, can edit draft content in projB only when assigned, and `getProjectsForUser(U)` returns projects from A (org-wide) and projB.

- [ ] **Step 2: Run**

Run: `npm test -- rbac-integration`
Expected: PASS.

- [ ] **Step 3: Final gate + commit**

```bash
npm run precheck
git add src/test/
git commit -m "test(rbac): multi-org user integration coverage"
```

---

## Self-Review Notes

- **Spec coverage:** unified `user_roles` table (Task 3); drop legacy columns/`project_users` (Task 18); SuperAdmin as global grant (engine Task 5 + seed Task 16); `authorize` single chain (Task 5/9); org membership emergent (Tasks 13/15 use grant-org queries); PM org-wide create (Task 5 test + route Task 11); `content:view` for observers, `membership:revoke`, `role:assign:*` (Task 2/16); migration mapping Manager→org-wide PM, Translator→pinned PT (Task 17); `user:delete` SuperAdmin-only / account deletion deferred (Task 16 + placeholder doc).
- **Type consistency:** `Grant { orgId, projectId, permissions }`, `AuthScope { orgId?, projectId? }`, `AppPolicyUser { id, grants }`, `authorize(user, permission, scope)` used identically across Tasks 5, 9, 10–15.
- **Known coupling:** the build is intentionally red from Task 4 through Task 15; `npm run typecheck` is asserted green at Task 15 Step 4 and the full gate at Task 18 Step 4.
- **Deployment order (per environment):** seed roles/permissions (Task 16) → `db:migrate-rbac` (Task 17) → `db:migrate` drop (Task 18). Never run the drop before the data migration.

---

## Appendix A — Requirements (established this conversation)

Captured verbatim/condensed from the source and the brainstorming dialogue so this plan is self-contained.
Source reference (with ER diagram): `docs/features/user-centric-rbac/reference/2026-06-02-tenant-diagram.md`.

### A.1 Problem statement

The current RBAC system assumes the **Org** is the central tenant of the application. It is not. **The User is the central tenant.** A user has an identity; orgs and projects are entities the user is *associated with*, each association carrying a role.

### A.2 User stories (Kevin Smith)

1. Kevin first joins Fluent to work on translation projects for his local community church. He is the **owner of the org**, the **project manager**, and a **translator**.
2. Kevin is invited by a larger Org to help **manage** some of their projects. He is not translating, only managing.
3. Kevin is invited by Org C to help as a **translator** on a project. He is only a translator.
4. Kevin acts as an **observer** for other projects and orgs. He does not require editing or managing permissions.

These imply a single user simultaneously holding different roles across multiple orgs and projects.

### A.3 Roles

- **SuperAdmin** — for System (Fluent) team members.
- **Org Owner** — owns the org; can administrate the org and assign Org Managers.
- **Org Manager** — can administrate the org; cannot assign Org Managers.
- **Project Manager** — can manage a project; assign users with PM or PT roles; **and create new projects for the org** (established this conversation — a reasonable level of permission for the role).
- **Project Translator** — can update project content they are assigned to in draft or peer-review; can update content at community-review status and beyond.
- **Project Observer** — read-only (added 2026-03-03 in source).

### A.4 Associations (the structural requirement)

- The **User is the central entity** for the system.
- A user can be associated with **multiple Orgs** (1:m).
- Projects are associated to an Org (1:1 — a project belongs to one org).
- A user can have **multiple roles per project** (1:m).
- **Roles are associated per org per project. Either can be null.**
  - Org-scoped role → `project_id` null.
  - Project-pinned role → both `org_id` and `project_id` set.
  - System role (SuperAdmin) → both null.

### A.5 Decisions locked in during brainstorming

1. **Role storage:** a single unified `user_roles(user_id, org_id?, project_id?, role_id)` table (not split org/project tables). Org membership is **emergent** — a user is "in" org O iff they hold ≥1 grant with `org_id = O`; there is no separate membership table.
2. **`users` columns:** **drop** both `users.organization` and `users.role`. Identity carries no inherent org or role; everything comes from grants. (`created_by` is kept.)
3. **SuperAdmin representation:** a normal role granted via a row with **both scopes null**, seeded with **all permissions**. Chosen specifically so there is **one** authorization chain — no `if (isSuperAdmin)` branch anywhere. (Rejected: boolean flag / separate table, which would force a second logic chain.)
4. **Scope lives on the grant, not the role:** a `Project Manager` grant can be **org-wide** (`project_id` null → manages/creates all projects in the org, incl. future) or **project-pinned**. This unifies today's org-wide `Manager` with the new "invited to one project" PM.
5. **Project Manager can create projects** in orgs where they hold a PM grant (org-scoped check counts project-pinned PM grants because they carry `org_id`; the role's permission set is the gate — translators are counted at org scope but lack `project:create`).
6. **Invitation flow:** when a PM invites a user to their project, the system creates a `user_roles` row `(invitee, org, project, designatedRole)` — which simultaneously **associates the invitee with the project's org** (emergent membership) and grants the project role the PM designated (PM or PT).
7. **Disassociation vs. account deletion (distinct concepts):**
   - **Disassociation** = revoking a user's grants within a scope. In scope now via the `membership:revoke` permission. Any org (Owner/Manager) or project (PM) actor can disassociate a user from the scope they control (PM: project-pinned grants on their projects only; Org roles: any grant in their org).
   - **Account deletion** belongs to the **user** (the account ultimately belongs to them; they control it). **Out of scope — future ticket.** `user:delete` is seeded to SuperAdmin only. Placeholder: `docs/features/account-self-management/design.md`.
8. **Existing data:** ~24 real production users. One-shot backfill migration (no dual-write):
   - Today's **`Manager` = Project Manager** (there is no Org Manager/Owner in the app today). Migrated to a single **org-wide PM grant** `(user, org, null, Project Manager)` — preserves all current behavior, covers future projects, handles managers in empty orgs.
   - Today's **`Translator` = Project Translator**. Migrated to a **project-pinned PT grant** per `project_users` row.
   - **No Org Owner / Org Manager backfill** — those roles start empty and are assigned going forward.

### A.6 Role → permission map (target)

| Role               | Permissions                                                                                                   |
|--------------------|---------------------------------------------------------------------------------------------------------------|
| **SuperAdmin**     | All permissions (incl. `user:delete`)                                                                         |
| **Org Owner**      | `project:*`, `content:view/assign/update`, `user:view/create/update`, `membership:revoke`, `role:assign:project`, `role:assign:org_manager` |
| **Org Manager**    | Same as Org Owner **minus** `role:assign:org_manager`                                                         |
| **Project Manager**| `project:view/create/update/delete`, `content:view/assign/update`, `user:view/create/update`, `membership:revoke`, `role:assign:project` |
| **Project Translator** | `project:view`, `content:view/update`, `user:view`, `user:update` (self)                                 |
| **Project Observer**   | `project:view`, `content:view`                                                                            |

### A.7 Out of scope (confirmed)

- New UI/endpoints for org-membership management and org-role assignment beyond what the project-invitation flow implies (follow-up tickets).
- Account self-management / deletion (see placeholder doc).
