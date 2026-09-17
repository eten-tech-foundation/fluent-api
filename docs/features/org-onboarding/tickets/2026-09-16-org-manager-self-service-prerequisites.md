# Org Manager self-service prerequisites for fluent-web #489

> **Status: NOT STARTED** — awaiting go-ahead to implement, and Product decision D1 (see below).
> GitHub: [fluent-api#337](https://github.com/eten-tech-foundation/fluent-api/issues/337)

**Parent feature:** [`org-onboarding`](../plan.md) — Ticket API-2. Task-level detail with tests also in `fluent-web/docs/features/org-manager-users-page/plan.md` Phase A.
**Repo:** `fluent-api`.
**Blocks:** fluent-web#489 (Users page org roles).
**Related:** #336 — independent, but ships the seeded `org_manager` account this ticket needs for QA.

## Problem

fluent-web#489 lets an Org Manager add/edit Org Managers and Project Managers from the Users page. Three API gaps make that fail or silently no-op:

1. `canAssignRole()` requires `ROLE_ASSIGN_ORG_MANAGER` for target role `Org Manager`; only SuperAdmin holds it (`rbac.ts:29-41`). An Org Manager inviting an Org Manager gets **403**.
2. `PATCH /users/:id` ignores `role` — not in `updateUserRequestSchema`, and stripped again in `users.repository.update()`. The Edit User dialog "saves" a role that never changes. No org-level role-change endpoint exists; only `PATCH /projects/{projectId}/users/{userId}`.
3. `Project Manager` exists only as a project-pinned grant; `canAssignRole` returns `false` for PM with `projectId === null` (`authorize.ts:82-90`). "Org-scoped Project Manager" as written in #489 is not in the model.

## Product decision D1 (open)

How should "Project Manager" behave on the org-level Users page?

- **(a) Org-level PM grant** — allow `Project Manager` with `projectId = null`. Matches #489's wording. `grant-utils.isProjectManager()` on the web already treats a null-project manager grant as managing every project in the org. New RBAC concept; touches `canAssignRole` and the TEMP bypass in `projects.route.ts:90-104`.
- **(b) Org Manager only** — the Users page offers only `Org Manager`; PMs stay per-project via Add Project User. Deviates from #489.

Task 3 below exists only under (a).

## Tasks

### 1. Org Manager may assign the Org Manager role

Files: `src/db/seeds/rbac.ts`, `src/lib/services/permissions/authorize.test.ts`, `src/middlewares/role-auth.ts` (+ test)

- [ ] Add `{ roleName: ROLES.ORG_MANAGER, permissionName: PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER }` to the Org Manager block.
- [ ] Tests: org-scoped Org Manager → `canAssignRole(…, ORG_MANAGER, ORG, null) === true`; same caller cannot assign `SuperAdmin`.
- [ ] `requireSuperAdmin` (`role-auth.ts:121-123`) comments call this permission SuperAdmin-exclusive; it no longer is. The check still holds because it also requires a _global_ grant. Fix the comment and add a test that an Org Manager holding the new permission is still rejected.

### 2. Org-level role change endpoint

Create: `src/domains/organizations/users/org-users.service.ts` (+ `.test.ts`), `org-users.types.ts`. Modify: `org-users.route.ts`.

```
PATCH /organizations/{orgId}/users/{userId}    body { roleName: 'Org Manager' | 'Project Manager'* }
middleware: authenticateUser, requireUserAccess(USER_ACTIONS.UPDATE, 'userId')
200 userResponseSchema (orgGrants refreshed)
400 roleName not allowed at org level
403 caller === target (self-change blocked, same as project route) OR !canAssignRole(caller, roleName, orgId, null)
404 target is not a member of orgId
```

\* only under D1 (a).

- [ ] Failing service tests: self-change → `FORBIDDEN`; non-member → `USER_NOT_FOUND`; replaces the existing org-level non-anchor grant, keeps the `Org Member` anchor and all project-scoped grants; idempotent when unchanged.
- [ ] Service `updateOrgUserRole(callerId, orgId, userId, roleName)`: `getRoleId`; in one transaction delete `user_roles` where `(userId, orgId, projectId IS NULL, role ≠ Org Member)`, insert the new grant; return `usersService.getUserById(userId)`.
- [ ] Route mirrors `updateProjectUserRoleRoute` in `project-users.route.ts:185-240`; body schema `z.object({ roleName: z.enum([...allowedOrgRoles]) })`.
- [ ] Unit tests for `canAssignRole` at scope `{ orgId, projectId: null }` for each allowed role.

### 3. Org-level Project Manager grant — only under D1 (a)

Files: `src/lib/services/permissions/authorize.ts` (+ test), `src/domains/projects/projects.route.ts`

- [ ] `canAssignRole` branch 4: `PROJECT_MANAGER && projectId === null` → require `ROLE_ASSIGN_PROJECT` at `{ orgId, projectId: null }`. Translator/Observer remain project-only.
- [ ] Tests: Org Manager can assign org-level PM; project-pinned PM cannot (grant not applicable at org scope); Translator/Observer at org scope still `false`.
- [ ] Revisit the TEMP bypass comment in `projects.route.ts:90-104` — an org-level PM satisfies the normal `authorize()` path. Keep the bypass for legacy project-pinned PMs or remove in a follow-up; document the choice.

Under D1 (b): skip, and restrict Task 2's enum to `Org Manager`.

### 4. Optional cleanup

- [ ] `PATCH /users/:id` handler (`users.route.ts:465-475`) deletes `updates.role` after zod already dropped it — dead code. Remove it; role changes go through org/project endpoints.

## Verification

```
pnpm test src/domains/organizations src/lib/services/permissions src/middlewares
pnpm typecheck && pnpm lint
```

After deploy, re-run the RBAC seed in each environment so existing Org Manager rows pick up the permission.
