# Temp: Project Manager Can Create Projects

## Why this exists

QA needs to be able to create and test projects before the proper Org Manager
workflow is in place. The correct long-term design is that only Org Managers
(org-scoped role) can create projects. Project Managers are project-scoped and
should not be able to create projects.

This bypass was added deliberately as a short-lived workaround.

---

## What was changed

### fluent-api

#### 1. `src/db/seeds/rbac.ts`

`PROJECT_CREATE` was kept in the Project Manager permission list. This is what
puts the permission into the PM's grant object at runtime. Without it, the
route bypass below would also fail.

```ts
// Keep until revert
{ roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.PROJECT_CREATE },
```

#### 2. `src/domains/projects/projects.route.ts` — `POST /projects` middleware

The normal `requirePermission(PROJECT_CREATE, orgFromBody)` check requires an
org-wide grant (`projectId = null`). Project Managers are always project-pinned,
so they would fail this check.

A TEMP block was added that also allows any grant carrying `project:create`
within the matching org (regardless of `projectId`). Search for `// TEMP:` in
the file to find the exact block.

---

## How the permission system works (context for newcomers)

When a user is assigned a role, a row is written to `user_roles`:

| userId | orgId | projectId | roleId          |
| ------ | ----- | --------- | --------------- | ----------------------------------- |
| 5      | 2     | null      | org_manager     | ← org-wide, CAN create projects     |
| 5      | 2     | 9         | project_manager | ← project-pinned, CANNOT (normally) |

At login, `findGrantsByUserId()` loads all rows and groups them into `Grant`
objects: `{ orgId, projectId, permissions: Set<...> }`.

When `project:create` is checked for `POST /projects`, the scope is
`{ orgId: X }` (no projectId). The core `authorize()` function requires
`grant.projectId === null` for org-level checks. A Project Manager's grant has
`projectId = 9`, so it fails the scope check even if `project:create` is in
their permission set.

The TEMP bypass skips this scope check, allowing PM through. Once Org Managers
exist in the system and QA accounts are set up properly, this bypass is no
longer needed.

---

## How to revert (when Org Manager workflow lands)

Do exactly these two things — nothing else in the system needs to change.

### Step 1 — `src/db/seeds/rbac.ts`

Remove this line from the `ROLE_PERMISSION_MAP`:

```ts
{ roleName: ROLES.PROJECT_MANAGER, permissionName: PERMISSIONS.PROJECT_CREATE },
```

Re-run the RBAC seed so the DB reflects the removal.

### Step 2 — `src/domains/projects/projects.route.ts`

Find the `// TEMP:` comment block in the `POST /projects` middleware and
collapse the entire `async (c, next) => { ... }` block back to the original:

```ts
(c: any, next: any) => {
  const user = c.get('user');
  const hasAnyOrg = user?.grants?.some((g: any) => g.orgId !== null);
  if (!hasAnyOrg) return next(); // zero-org solo path — skip permission gate
  return requirePermission(PERMISSIONS.PROJECT_CREATE, orgFromBody)(c, next);
},
```

---

## Files summary

| File                                     | What to revert                                  |
| ---------------------------------------- | ----------------------------------------------- |
| `src/db/seeds/rbac.ts`                   | Remove `PROJECT_MANAGER + PROJECT_CREATE` entry |
| `src/domains/projects/projects.route.ts` | Collapse TEMP middleware back to 3-liner        |

`fluent-web` does not need any changes for this revert.
