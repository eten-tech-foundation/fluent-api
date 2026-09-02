# Permissions & Authorization Reference

This document describes the authorization system in `fluent-api`: how roles, permissions, and scopes interact, how requests are authenticated and authorized, and how fine-grained access policies work per domain.

---

## Table of Contents

- [Overview](#overview)
- [Database Schema](#database-schema)
- [Roles](#roles)
- [Permissions](#permissions)
- [Role–Permission Matrix](#rolepermission-matrix)
- [Grants & Scope](#grants--scope)
- [The authorize() Function](#the-authorize-function)
- [Request Authorization Chain](#request-authorization-chain)
  - [Layer 0: authenticate](#layer-0-authenticate)
  - [Layer 1: authenticateUser](#layer-1-authenticateuser)
  - [Layer 2: requirePermission](#layer-2-requirepermission)
  - [Layer 3: requireSelf / requireSuperAdmin](#layer-3-requireself--requiresuperadmin)
  - [Layer 4: Domain Policies](#layer-4-domain-policies)
- [Role Assignment Rules (canAssignRole)](#role-assignment-rules-canassignrole)
- [Domain Policies](#domain-policies)
  - [ProjectPolicy](#projectpolicy)
  - [UserPolicy](#userpolicy)
  - [ChapterAssignmentPolicy](#chapterassignmentpolicy)
  - [AiSuggestionsPolicy](#aisuggestionspolicy)
- [Scope Resolvers](#scope-resolvers)
- [activeOrgId](#activeorgid)
- [User Invitation & Role Assignment](#user-invitation--role-assignment)

---

## Overview

Authorization in `fluent-api` is layered:

1. **RBAC** — a user is assigned one or more roles, each role carries a fixed set of permissions.
2. **Scoped grants** — role assignments are scoped to an organization and/or project. A role does not grant access globally unless explicitly assigned at the global scope.
3. **Policies** — after the coarse RBAC gate, record-level policies enforce fine-grained rules (e.g. a translator can only edit content assigned to them).

There are no per-user permission overrides. All access derives from role assignments.

---

## Database Schema

The RBAC system uses four tables:

```
roles              (id, name)
permissions        (id, name, description)
role_permissions   (roleId → roles.id, permissionId → permissions.id)   [composite PK]
user_roles         (id, userId → users.id, orgId?, projectId?, roleId → roles.id)
```

`user_roles` is the central assignment table. The `orgId` and `projectId` columns are nullable, which drives the scope hierarchy:

| `orgId` | `projectId` | Meaning                                      |
| ------- | ----------- | -------------------------------------------- |
| `NULL`  | `NULL`      | Global scope — SuperAdmin                    |
| `N`     | `NULL`      | Org-wide — covers all projects within org N  |
| `N`     | `M`         | Project-scoped — only project M within org N |

See [`src/db/schema.ts`](../src/db/schema.ts) (tables `roles`, `permissions`, `role_permissions`, `user_roles`) and [`src/db/seeds/rbac.ts`](../src/db/seeds/rbac.ts) for the seed data.

---

## Roles

Defined in [`src/lib/roles.ts`](../src/lib/roles.ts).

```typescript
export const ROLES = {
  SUPER_ADMIN: 'SuperAdmin',
  ORG_MANAGER: 'Org Manager',
  ORG_MEMBER: 'Org Member',
  PROJECT_MANAGER: 'Project Manager',
  PROJECT_TRANSLATOR: 'Project Translator',
  PROJECT_OBSERVER: 'Project Observer',
} as const;
```

| Role                 | Typical Scope                         | Purpose                                                                                              |
| -------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SuperAdmin`         | Global (`orgId=null, projectId=null`) | Full access to everything. Can assign any role.                                                      |
| `Org Manager`        | Org-wide                              | Manage projects and users within an organization.                                                    |
| `Org Member`         | Org-wide                              | Structural membership role. No content permissions. Grants eligibility to be assigned project roles. |
| `Project Manager`    | Project                               | Full control over a single project and its content.                                                  |
| `Project Translator` | Project                               | Edit content and use AI tools on assigned chapters.                                                  |
| `Project Observer`   | Project                               | Read-only access to a project.                                                                       |

> **Note on `Org Member`:** This role has no permissions seeded in the database. It exists to express org membership without granting any content capabilities. A user can simultaneously hold `Org Member` (org scope) and `Project Translator` (project scope).

---

## Permissions

Defined in [`src/lib/permissions.ts`](../src/lib/permissions.ts). Each string value corresponds to a row in the `permissions` table.

```typescript
export const PERMISSIONS = {
  // Projects
  PROJECT_VIEW: 'project:view',
  PROJECT_CREATE: 'project:create',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',

  // Content
  CONTENT_VIEW: 'content:view',
  CONTENT_ASSIGN: 'content:assign',
  CONTENT_UPDATE: 'content:update',

  // Membership / role assignment
  MEMBERSHIP_REVOKE: 'membership:revoke',
  ROLE_ASSIGN_PROJECT: 'role:assign:project',
  ROLE_ASSIGN_ORG_MANAGER: 'role:assign:org_manager',

  // AI tools — intentional alias of CONTENT_UPDATE (same string, no separate DB row).
  // Promoting to a distinct permission only requires changing this string value.
  AI_TOOLS_USE: 'content:update',

  // Users
  USER_VIEW: 'user:view',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
} as const;
```

`AI_TOOLS_USE` is an intentional alias of `CONTENT_UPDATE`. It is used as a named constant at call sites so the intent is clear. There is no separate `ai_tools_use` row in the database.

---

## Role–Permission Matrix

Derived from [`src/db/seeds/rbac.ts`](../src/db/seeds/rbac.ts). ✅ = granted, — = not granted.

| Permission                | SuperAdmin | Org Manager | Org Member | Project Manager | Project Translator | Project Observer |
| ------------------------- | :--------: | :---------: | :--------: | :-------------: | :----------------: | :--------------: |
| `project:view`            |     ✅     |     ✅      |     —      |       ✅        |         ✅         |        ✅        |
| `project:create`          |     ✅     |     ✅      |     —      |       ✅        |         —          |        —         |
| `project:update`          |     ✅     |     ✅      |     —      |       ✅        |         —          |        —         |
| `project:delete`          |     ✅     |     ✅      |     —      |       ✅        |         —          |        —         |
| `content:view`            |     ✅     |     ✅      |     —      |       ✅        |         ✅         |        ✅        |
| `content:assign`          |     ✅     |     ✅      |     —      |       ✅        |         —          |        —         |
| `content:update`          |     ✅     |     ✅      |     —      |       ✅        |         ✅         |        —         |
| `membership:revoke`       |     ✅     |     ✅      |     —      |       ✅        |         —          |        —         |
| `role:assign:project`     |     ✅     |     ✅      |     —      |       ✅        |         —          |        —         |
| `role:assign:org_manager` |     ✅     |      —      |     —      |        —        |         —          |        —         |
| `user:view`               |     ✅     |     ✅      |     —      |       ✅        |         ✅         |        ✅        |
| `user:create`             |     ✅     |     ✅      |     —      |       ✅        |         —          |        —         |
| `user:update`             |     ✅     |     ✅      |     —      |       ✅        |         ✅         |        —         |
| `user:delete`             |     ✅     |      —      |     —      |        —        |         —          |        —         |

> Users can view and edit their own profile regardless of role. The permissions above do not cover this.

---

## Grants & Scope

When a user authenticates, their complete set of role assignments is loaded from `user_roles` and flattened into **grants** — one grant per distinct `(orgId, projectId)` scope.

```typescript
// src/lib/types.ts
export interface Grant {
  orgId: number | null;
  projectId: number | null;
  permissions: ReadonlySet<Permission>;
}
```

A **scope** defines the context of a permission check:

```typescript
export interface AuthScope {
  orgId?: number | null;
  projectId?: number | null;
}
```

Examples:

```typescript
// SuperAdmin — global grant
{ orgId: null, projectId: null, permissions: Set['role:assign:org_manager', ...] }

// Org Manager at Org 5 — covers all projects in org 5
{ orgId: 5, projectId: null, permissions: Set['project:create', 'project:update', ...] }

// Project Translator on Project 12 of Org 5 — only that project
{ orgId: 5, projectId: 12, permissions: Set['content:update', 'project:view', ...] }
```

---

## The `authorize()` Function

Defined in [`src/lib/services/permissions/authorize.ts`](../src/lib/services/permissions/authorize.ts).

```typescript
export function authorize(user: AppPolicyUser, permission: Permission, scope: AuthScope): boolean {
  return collectPermissions(user.grants, scope).has(permission);
}
```

`collectPermissions` filters the user's grants to those applicable to the given scope, then unions their permissions. A grant is applicable if:

```typescript
function isGrantApplicable(grant, orgId, projectId): boolean {
  // Global grant — always applies (SuperAdmin)
  if (grant.orgId === null && grant.projectId === null) return true;

  if (projectId !== null) {
    // Grant pinned to this exact project
    if (grant.projectId === projectId && grant.orgId === orgId) return true;
    // Org-wide grant also covers all projects in that org
    if (grant.projectId === null && grant.orgId === orgId) return true;
    return false;
  }

  if (orgId !== null) {
    // Org-scoped check: project-pinned grants do NOT satisfy org-level actions
    return grant.orgId === orgId && grant.projectId === null;
  }

  return false;
}
```

Key rule: a grant pinned to a specific project never satisfies an org-level permission check. A translator on Project 12 cannot create a new project in Org 5.

---

## Request Authorization Chain

Every protected request passes through the following chain. Layers are applied in order; any failure short-circuits the request with an HTTP error.

```
Request
  │
  ▼
[Layer 0] authenticate          — BetterAuth session validation + grant loading
  │  ❌ 401 if token invalid or expired
  ▼
[Layer 1] authenticateUser      — Presence + account status check
  │  ❌ 401 if no user in context
  │  ❌ 403 if user.status === 'inactive'
  ▼
[Layer 2] requirePermission()   — Coarse RBAC gate
  │  ❌ 403 if user holds no grant with this permission
  ▼
[Layer 3] requireSelf()         — (user routes only) identity check
        requireSuperAdmin()     — (admin routes only) global SuperAdmin check
  │  ❌ 403 if check fails
  ▼
[Layer 4] Domain Policy         — Record-level access check
  │  ❌ 403/404 depending on domain convention
  ▼
[Route Handler]
```

### Layer 0: `authenticate`

[`src/middlewares/authenticate.ts`](../src/middlewares/authenticate.ts)

Runs globally on every request except `/api/auth/*` and `/ai-suggestions/internal/*` (which use service-key authentication via `requireServiceAuth`).

Responsibilities:

- Calls `auth.api.getSession()` to validate the BetterAuth session (cookie or Bearer token).
- Looks up the application user record via email.
- Loads all grants by calling `findGrantsByUserId()` and sets them on the request context.
- Resolves and sets `activeOrgId` (see [activeOrgId](#activeorgid)).
- Handles mobile session rolling: if `isMobile=true` and session has less than 30 days remaining, extends expiry by 60 days (throttled to once per 24h).

If a Bearer token is provided but invalid, returns granular errors:

- `401 Invalid or revoked session token` — token not in DB
- `401 Session token has expired` — token exists but past `expiresAt`

### Layer 1: `authenticateUser`

[`src/middlewares/role-auth.ts`](../src/middlewares/role-auth.ts)

Used explicitly on routes that require an authenticated user. Checks that `c.get('user')` is populated (by Layer 0) and that `user.status !== 'inactive'`.

### Layer 2: `requirePermission()`

[`src/middlewares/role-auth.ts`](../src/middlewares/role-auth.ts)

```typescript
export function requirePermission(permission: Permission, resolveScope?: ScopeResolver);
```

Coarse gate — checks whether the user holds the given permission in any applicable grant.

**Behaviour differs based on whether `resolveScope` is provided:**

| Call form                                        | Check performed                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `requirePermission(PERMISSIONS.X)`               | `grants.some(g => g.permissions.has(X))` — scope-free: does the user hold this permission anywhere?  |
| `requirePermission(PERMISSIONS.X, resolveScope)` | `authorize(user, X, scope)` — scope-aware: does the user hold this permission in the resolved scope? |

The scope-free form is used when the specific resource is not yet known (e.g. before loading the record from the DB). The full scope check is then enforced in Layer 4.

### Layer 3: `requireSelf` / `requireSuperAdmin`

[`src/middlewares/role-auth.ts`](../src/middlewares/role-auth.ts)

**`requireSelf()`** — used on user-scoped routes (e.g. `GET /users/:userId`). Verifies that `user.id === Number(c.req.param('userId'))`. Returns `403` if the caller is not the target user.

**`requireSuperAdmin()`** — verifies the caller has a global grant (`orgId=null, projectId=null`) that includes `role:assign:org_manager`. Returns `403` otherwise.

### Layer 4: Domain Policies

Called from domain-specific middleware after the record has been loaded from the database. See [Domain Policies](#domain-policies) below.

---

## Role Assignment Rules (`canAssignRole`)

Defined in [`src/lib/services/permissions/authorize.ts`](../src/lib/services/permissions/authorize.ts).

```typescript
export function canAssignRole(
  caller: AppPolicyUser,
  targetRoleName: string,
  orgId: number,
  projectId: number | null
): boolean;
```

| Target Role          | Required Permission                                                 | Additional Constraint                                               |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `SuperAdmin`         | `role:assign:org_manager`                                           | Caller must also have a global grant (`orgId=null, projectId=null`) |
| `Org Manager`        | `role:assign:org_manager`                                           | Checked at the given `orgId` scope                                  |
| `Org Member`         | `user:create` OR `role:assign:project` OR `role:assign:org_manager` | Any of these at the given scope                                     |
| `Project Manager`    | `role:assign:project`                                               | `projectId` must not be null                                        |
| `Project Translator` | `role:assign:project`                                               | `projectId` must not be null                                        |
| `Project Observer`   | `role:assign:project`                                               | `projectId` must not be null                                        |

---

## Domain Policies

Policies answer: **can this user perform this action on this specific record?**

They are called after the coarse `requirePermission()` gate and always receive the loaded record alongside the policy user.

### ProjectPolicy

[`src/domains/projects/project.policy.ts`](../src/domains/projects/project.policy.ts)

| Method                                      | Logic                                                                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list(user)`                                | True if user holds `project:view` in any grant.                                                                                                                 |
| `read(user, project, isAssignedToProject?)` | `project:view` at `{orgId, projectId}` scope, OR the user is assigned to the project (allows translators to see their own projects without a broad view grant). |
| `update(user, project)`                     | `project:update` at `{orgId, projectId}` scope.                                                                                                                 |
| `delete(user, project)`                     | `project:delete` at `{orgId, projectId}` scope.                                                                                                                 |

Enforced via `requireProjectAccess(action)` in [`project-auth.middleware.ts`](../src/domains/projects/project-auth.middleware.ts). A failed check returns `404 Project not found` rather than `403` to avoid leaking project existence.

### UserPolicy

[`src/domains/users/user.policy.ts`](../src/domains/users/user.policy.ts)

| Method                 | Logic                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `list(user)`           | True if user holds `user:view` in any grant.                                                           |
| `create(user)`         | True if user holds `user:create` in any grant.                                                         |
| `view(user, target)`   | Self-access always allowed. Otherwise `user:view` at global scope or at any org the target belongs to. |
| `update(user, target)` | Self-access always allowed. Otherwise `user:update` at global scope or at any shared org.              |
| `delete(user, target)` | `user:delete` at global scope only — SuperAdmin only.                                                  |

### ChapterAssignmentPolicy

[`src/domains/chapter-assignments/chapter-assignments.policy.ts`](../src/domains/chapter-assignments/chapter-assignments.policy.ts)

The most complex policy. The `edit` method enforces assignment-position rules and workflow-stage gates.

| Method               | Required Permission       | Additional Constraint                                                                                                           |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `view`               | `content:view` at scope   | OR user is a project member                                                                                                     |
| `create`             | `content:assign` at scope | —                                                                                                                               |
| `update`             | `content:assign` at scope | —                                                                                                                               |
| `delete`             | `content:assign` at scope | —                                                                                                                               |
| `deleteAll`          | `content:assign` at scope | —                                                                                                                               |
| `assignAll`          | `content:assign` at scope | —                                                                                                                               |
| `assign`             | `content:assign` at scope | —                                                                                                                               |
| `submit`             | Delegates to `edit`       | —                                                                                                                               |
| `edit` (translators) | `content:update` at scope | Status `draft`: must be `assignedUserId`. Status `peer_check`: must be `peerCheckerId`. Post-peer statuses: any project member. |
| `edit` (managers)    | `content:assign` at scope | Only at post-peer statuses: `community_review`, `linguist_check`, `theological_check`, `consultant_check`.                      |
| `toggleAi`           | `content:assign`          | OR (`content:update` AND status=`draft` AND `assignedUserId === user.id`)                                                       |
| `isParticipant`      | Delegates to `edit`       | —                                                                                                                               |

### AiSuggestionsPolicy

[`src/domains/ai-suggestions/ai-suggestions.policy.ts`](../src/domains/ai-suggestions/ai-suggestions.policy.ts)

| Method                                | Logic                                                             |
| ------------------------------------- | ----------------------------------------------------------------- |
| `canAccessProjectUnit(user, context)` | `project:view` OR `content:update` at `{orgId, projectId}` scope. |

---

## Scope Resolvers

[`src/middlewares/role-auth.ts`](../src/middlewares/role-auth.ts)

A `ScopeResolver` is a function that extracts an `AuthScope` from the request context. Passed as the second argument to `requirePermission()`.

```typescript
export type ScopeResolver = (c: Context<AppBindings>) => AuthScope | Promise<AuthScope>;
```

**Built-in resolver: `orgFromBody`**

Reads `orgId` (or `organization`) and `projectId` from the JSON request body. Used on routes such as `POST /projects` where the org context is provided in the body rather than in the URL.

```typescript
export const orgFromBody: ScopeResolver = async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const orgId = Number(body?.orgId ?? body?.organization);
  const projectId = Number(body?.projectId);
  return {
    ...(Number.isFinite(orgId) ? { orgId } : {}),
    ...(Number.isFinite(projectId) ? { projectId } : {}),
  };
};
```

---

## activeOrgId

Set on the request context by the `authenticate` middleware. Represents the user's currently active organization for the session.

Resolution order:

1. `auth_session.active_org_id` if set.
2. Falls back to `users.last_active_org_id` if the session column is null (and backfills the session column in that case).

Available as `c.get('activeOrgId')` in route handlers and domain middleware. Can be used as a default org scope where the route does not require an explicit `orgId` parameter.

---

## User Invitation & Role Assignment

When a user is added to an organization — whether as a brand-new user or an existing one — the system always writes **two grants** in order:

1. **Org Member anchor** (`inviteUserToOrg`) — an org-wide `Org Member` role (`orgId=N, projectId=null`). This has no content permissions but marks the user as belonging to the organization.
2. **Caller-specified role** (`grantRole`) — the actual role the inviter chose (e.g. `Project Translator` scoped to a specific project, or `Org Manager` scoped to the org).

The anchor row is always written first. If `grantRole` subsequently fails, the anchor is not rolled back for existing users (they retain org membership). For new users, both the user record and the auth identity are fully rolled back.

### New User Flow (`createUserWithInvitation`)

Called when the inviter creates a user who does not yet exist in the system.

Defined in [`src/lib/services/auth/auth.service.ts`](../src/lib/services/auth/auth.service.ts).

```
1. INSERT into auth_user          — BetterAuth identity record
2. INSERT into users              — application user record
3. inviteUserToOrg(userId, orgId) — Org Member anchor grant
4. grantRole(userId, orgId, projectId, roleId) — inviter-specified role
5. auth.api.signInMagicLink()     — sends magic-link email to /accept-invitation
```

If step 3 or 4 fails, both `users` and `auth_user` records are deleted. If step 5 (email) fails, all records are deleted.

### Existing User Flow (`inviteExistingUserToOrg`)

Called when the inviter adds a user who already has an account in the system (e.g. a user from another org).

Defined in [`src/lib/services/auth/auth.service.ts`](../src/lib/services/auth/auth.service.ts).

```
1. inviteUserToOrg(userId, orgId) — Org Member anchor grant (idempotent)
2. grantRole(userId, orgId, projectId, roleId) — inviter-specified role
3. sendExistingUserOrgInviteEmail() — notification email with login link
```

No user records are created or rolled back. The `grantRole` call uses `onConflictDoNothing`, so re-inviting a user who already holds that role is a no-op.

### What Role Can the Inviter Assign?

The inviter can only assign roles they are authorized to grant, as enforced by `canAssignRole()` (see [Role Assignment Rules](#role-assignment-rules-canassignrole)). In practice:

| Inviter Role      | Can Assign                                                                |
| ----------------- | ------------------------------------------------------------------------- |
| `SuperAdmin`      | Any role                                                                  |
| `Org Manager`     | `Org Member`, `Project Manager`, `Project Translator`, `Project Observer` |
| `Project Manager` | `Project Translator`, `Project Observer` (within their project)           |

### Project Creator Auto-Grant

When a user creates a new project (`POST /projects`), the system automatically grants them `Project Manager` on that project immediately after creation. This is handled in [`src/domains/projects/projects.route.ts`](../src/domains/projects/projects.route.ts):

```
1. createProject(...)            — project record inserted
2. grantRole(userId, orgId, projectId, pmRoleId) — creator gets Project Manager
```

If the grant fails, the project is deleted and the request returns an error.
