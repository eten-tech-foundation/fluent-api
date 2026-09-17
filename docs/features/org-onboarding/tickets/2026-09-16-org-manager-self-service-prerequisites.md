# Org Manager self-service prerequisites for fluent-web #489

> **Status: IMPLEMENTED (local)** — on `feat/org-manager-self-service`, awaiting review before push.
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

## Product decisions (resolved 2026-09-16)

- **D1 → Option (b):** Project roles stay project-scoped. The Users page manages org-level roles only — `Org Manager` (promote) and `Org Member` (demote, removes the org-level role while keeping the anchor + project grants). There is no org-level Project Manager; Task 3 is dropped.
- **D2 → Self-change block is the guard:** an Org Manager cannot change their own org-level role; they can only be demoted by a different Org Manager, which keeps the org with ≥1 OM. Self-removal via DELETE is blocked for the same reason.
- **D3 → display order** is a web concern (member → org-level role → project role priority PM > Translator > Observer); no API change.
- **Removal notice:** `DELETE /organizations/{orgId}/users/{userId}` already clears chapter assignments + all org grants; the "user has assignments" warning is rendered web-side via `GET /users/{userId}/chapter-assignments`.

## Tasks

### 1. Org Manager may assign the Org Manager role

Files: `src/db/seeds/rbac.ts`, `src/lib/services/permissions/authorize.test.ts`, `src/middlewares/role-auth.ts` (+ test)

- [x] Add `{ roleName: ROLES.ORG_MANAGER, permissionName: PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER }` to the Org Manager block.
- [x] Tests: org-scoped Org Manager → `canAssignRole(…, ORG_MANAGER, ORG, null) === true`; same caller cannot assign `SuperAdmin`; project-pinned `role:assign:org_manager` cannot satisfy org scope.
- [x] `requireSuperAdmin` comment updated (permission no longer exclusive; global-grant requirement keeps the check). New `src/middlewares/role-auth.test.ts` proves an org-scoped OM holding the permission is still rejected.

### 2. Org-level role change endpoint

Created: `org-users.service.ts`, `org-users.service.test.ts`, `org-users.types.ts`. Modified: `org-users.route.ts`, `org-users.repository.ts`.

```
PATCH /organizations/{orgId}/users/{userId}    body { roleName: 'Org Manager' | 'Org Member' }
middleware: authenticateUser, requirePermission(USER_UPDATE, orgId-from-param)
handler:    canAssignRole(caller, roleName, orgId, null) → 403
200 userResponseSchema (grants refreshed)
400 target is not a member of orgId (USER_NOT_IN_ORGANIZATION, per getHttpStatus)
403 caller === target (self-change, D2) OR !canAssignRole
```

- [x] Service tests: self-change → `FORBIDDEN` (repo untouched); non-member → `USER_NOT_IN_ORGANIZATION`; success returns refreshed user; repo failure propagates.
- [x] `repo.updateOrgUserRole` in one transaction: `roleId === orgMemberRoleId` → delete non-anchor org-level rows (demote); otherwise replace the non-anchor org-level row set with the new grant (idempotent when unchanged). Anchor + project-scoped grants always preserved.
- [x] DELETE org-user now also rejects `caller.id === userId` (self-removal) → 403, consistent with D2.

### 3. ~~Org-level Project Manager grant~~ — dropped per D1 (b)

### 4. Cleanup

- [x] Removed dead `updates.role` strip + unused `authorize`/`hasGrantManagement` block from `PATCH /users/:id` (`users.route.ts`). Role changes go through the org/project endpoints only.

## Verification

```
pnpm test src/domains/organizations src/lib/services/permissions src/middlewares
pnpm typecheck && pnpm lint
```

After deploy, re-run the RBAC seed in each environment so existing Org Manager rows pick up the permission.
