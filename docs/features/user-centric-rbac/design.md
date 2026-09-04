# User-Central RBAC — Design Spec

**Date:** 2026-06-02
**Status:** Approved for implementation planning
**Source:** `docs/features/user-centric-rbac/reference/2026-06-02-tenant-diagram.md`

## Problem

The current RBAC model treats the **organization** as the central tenant. Every
user belongs to exactly one org and holds exactly one global role:

- `users.organization` — `NOT NULL`, single FK → one org per user.
- `users.role` — `NOT NULL`, single FK → one global role per user (`Manager` or
  `Translator`).
- Permissions are global per role (`role_permissions`); `requirePermission()`
  checks the user's single role.
- Record-level policies hardcode `user.organization === resource.organization`
  and `user.roleName === ROLES.X`.

This cannot express the real domain (see the user stories): one person works
across **multiple orgs**, holding **different roles per org and per project**.
Kevin Smith is simultaneously an org owner in Org A, an org-level manager in
Org B, a translator in Org C, and an observer in Org D.

**The user must be the central tenant.** A user has an identity; orgs and
projects are things they are *associated with*, carrying a role per association.

## Goals

- One user ↔ many orgs (1:m), many roles, scoped per-org and/or per-project.
- A single, data-driven authorization path — no per-identity branching, no
  parallel logic chains.
- Preserve current behavior for the ~24 existing production users through a
  one-shot data migration.

## Non-Goals

- New UI / endpoints for org-membership management and org-role assignment
  beyond what the project-invitation flow already implies. Those are follow-up
  tickets.
- **Account self-management / account deletion** — deferred. See
  `docs/features/account-self-management/design.md`.

## Core Insight — Scope Lives on the Grant, Not the Role

A role's *reach* is determined by the **scope of the grant**, not by the role
itself. A `Project Manager` grant can be:

- **Org-wide** (`project_id` null): manages and creates *all* projects in the
  org, including ones created later.
- **Project-pinned** (`project_id` set): that one project only.

Same role, different reach. This is what lets today's org-wide `Manager` and the
new "invited to one project" PM be the *same role* — and makes the migration one
row per user.

## Data Model

### New table: `user_roles`

| Column       | Type      | Notes                                            |
|--------------|-----------|--------------------------------------------------|
| `id`         | serial PK |                                                  |
| `user_id`    | int FK    | → `users.id`, **NOT NULL**, `onDelete: cascade`  |
| `org_id`     | int FK    | → `organizations.id`, **NULLABLE**               |
| `project_id` | int FK    | → `projects.id`, **NULLABLE**, `onDelete: cascade` |
| `role_id`    | int FK    | → `roles.id`, **NOT NULL**                       |
| `created_by` | int FK    | → `users.id`, nullable                           |
| `created_at` | timestamp | default now                                      |
| `updated_at` | timestamp | `$onUpdate`                                      |

- **Unique** on `(user_id, org_id, project_id, role_id)`.
- **Indexes** on `user_id`, `org_id`, `project_id`.

Grant-shape semantics:

| Grant shape                          | Meaning                                  |
|--------------------------------------|------------------------------------------|
| `(user, null, null, SuperAdmin)`     | System-wide, every permission            |
| `(user, O, null, Org Owner/Manager)` | Org-wide role over org O                 |
| `(user, O, null, Project Manager)`   | Org-wide PM (manages all projects in O)  |
| `(user, O, P, Project Manager/…)`    | Role pinned to project P in org O        |

### Org membership is emergent

A user belongs to org O **iff** they have ≥1 `user_roles` row with `org_id = O`.
There is no separate membership table. Inviting a user to a project (which
creates a `(user, O, P, role)` row) *is* what associates them with org O.

### Removed from `users`

- Drop `users.organization` and `users.role`. (`created_by` is kept.)
- `findByEmail` no longer inner-joins `roles` for a single `roleName`; the user's
  grants are loaded separately (see Authorization).

### Removed table: `project_users`

`project_users` was membership-only and is now fully represented by `user_roles`
rows that carry a `project_id`. `isAssignedToProject(user, project)` becomes
"a `user_roles` row exists for this user + project." All references
(`projects.policy`, project/chapter-assignment routes, repositories) switch to
querying `user_roles`.

### `roles` table

Add the full role set: `SuperAdmin`, `Org Owner`, `Org Manager`,
`Project Manager`, `Project Translator`, `Project Observer`. Existing
`Manager`/`Translator` rows are remapped during migration (see Migration).

## Permission Model

### Permission catalog

Existing strings are retained. Two new permissions are added:

- `content:view` — read content without `content:update` (for Observer, and
  granted to every role that can currently update content).
- `membership:revoke` — disassociate a user from a scope (delete their
  `user_roles` rows within the actor's scope). **Replaces** the old reliance on
  `user:delete` for removing people from orgs/projects.
- `role:assign:project` — grant Project-tier roles (PM/PT/Observer) on a project
  the actor manages.
- `role:assign:org_manager` — grant Org Manager roles (Org Owner only).

`user:delete` (deleting the *account record* itself) is **removed from all
org/project roles**. Account deletion is owner-of-the-account (self) territory
and is deferred to a future ticket.

### Role → permission map (seed)

| Role               | Permissions                                                                                                   |
|--------------------|---------------------------------------------------------------------------------------------------------------|
| **SuperAdmin**     | All permissions                                                                                               |
| **Org Owner**      | `project:*`, `content:view/assign/update`, `user:view/create/update`, `membership:revoke`, `role:assign:project`, `role:assign:org_manager` |
| **Org Manager**    | Same as Org Owner **minus** `role:assign:org_manager`                                                         |
| **Project Manager**| `project:view/create/update/delete`, `content:view/assign/update`, `user:view/create/update`, `membership:revoke`, `role:assign:project` |
| **Project Translator** | `project:view`, `content:view/update`, `user:view`, `user:update` (self)                                 |
| **Project Observer**   | `project:view`, `content:view`                                                                            |

Notes:

- **Project Manager carries today's full `Manager` set** (so the 24 migrated
  users lose nothing) plus the new assignment/revoke permissions. Because PM
  grants carry `org_id`, an org-scoped check (e.g. `project:create`) counts them
  → a PM can create projects in their org. A Translator grant is also counted at
  org scope but its set lacks `project:create`, so translators still cannot.
- `membership:revoke` is scope-gated: a PM can revoke only project-pinned grants
  on projects they manage; Org Owner/Manager can revoke any grant in their org.

## Authorization — One Resolution Function

### Load grants once, in-memory thereafter

In the `authenticate` middleware, after resolving the application user, load
**all** of the user's `user_roles` grants (joined to role + permission names)
and attach them to context as `user.grants`. With ~24 users and few grants each,
this is negligible and keeps every downstream check in-memory.

`AppPolicyUser` changes:

```ts
// before
interface AppPolicyUser { id: number; roleName: string; organization: number; }
// after
interface AppPolicyUser {
  id: number;
  grants: Grant[];                 // { orgId: number|null, projectId: number|null, permissions: Set<string> }
  can(permission: Permission, scope: { orgId?: number; projectId?: number }): boolean;
}
```

### The single check

```
authorize(user, permission, { orgId?, projectId? }):
  applicable =
    grants where (orgId IS NULL  AND projectId IS NULL)            # global / SuperAdmin
    ∪ (projectId given:
         grants where (org_id = orgId AND project_id IS NULL)      # org-wide roles over this org
         ∪ grants where (project_id = projectId))                  # grants pinned to THIS project
       else:                                                       # org-scoped action (no project yet)
         grants where (org_id = orgId))                            # ANY grant in this org
  perms = union of applicable grants' permission sets
  return permission ∈ perms
```

- **Project-scoped action** (update project P in org O): a PM pinned to a
  *different* project in O does **not** apply — PMs can't reach across projects.
  An org-wide PM grant (`project_id` null) *does* apply.
- **Org-scoped action** (create a project in O, where there's no `project_id`
  yet): any grant in O applies; the role's permission set is the gate.
- **SuperAdmin** is a global grant whose role has every permission → satisfies
  every check with zero special-casing.

### Touch points

- `roleHasPermission(roleId, permission)` → replaced by `authorize`/`user.can`.
- `requirePermission(permission)` → `requirePermission(permission, scopeFn)`,
  where `scopeFn(c)` extracts `{ orgId?, projectId? }` from route params / the
  target resource. Most routes already carry `:projectId`; the org is derived
  from the project or request body.
- Every policy file (`project.policy.ts`, `chapter-assignments.policy.ts`,
  `chapter-assignment` and `translated-verse` auth middlewares, the user-auth
  middleware) is rewritten to call `authorize` with the **resource's** scope
  instead of comparing `user.organization === resource.organization`.

## Migration (one-shot script, ~24 users)

Run inside a transaction:

1. Seed the new roles and the role→permission map.
2. For each existing user:
   - **`Manager`** → one grant `(user, organization, null, Project Manager)` —
     org-wide PM. Preserves all current behavior (manage every project incl.
     future, create projects, manage users); no project enumeration; handles
     managers in empty orgs.
   - **`Translator`** → one grant `(user, organization, project, Project
     Translator)` for each `project_users` row.
3. Verify row counts (every migrated user has ≥1 grant).
4. Drop `users.organization`, `users.role`, and the `project_users` table.

No `Org Owner` / `Org Manager` backfill — those roles start empty and are
assigned going forward.

## Testing

- **Unit:** `authorize` resolution across all grant shapes — global, org-wide,
  project-pinned, cross-project isolation, org-scoped vs project-scoped actions,
  SuperAdmin.
- **Policy:** each rewritten policy file against multi-grant users.
- **Migration:** seed an Org-central fixture, run the script, assert resulting
  `user_roles` rows and that dropped columns/tables are gone.
- **Integration:** representative routes (project CRUD, chapter assignment,
  content update) for a user who is PM in one org and Translator in another —
  confirm correct allow/deny per scope.

## Open Items

None blocking. Account self-management / deletion is tracked separately in
`docs/features/account-self-management/design.md`.
