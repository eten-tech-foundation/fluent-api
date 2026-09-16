# Org Onboarding — API Implementation Plan

**Goal:** Let a SuperAdmin create a new organization and invite its first Org Manager without developer intervention, then let that Org Manager add further Org Managers / Project Managers from the Users page (fluent-web #489).

**Companion plan (web side):** `fluent-web/docs/features/org-onboarding/plan.md`
**Downstream plan:** `fluent-web/docs/features/org-manager-users-page/plan.md` (#489)

**Tech Stack:** Hono + `@hono/zod-openapi`, Drizzle, Vitest

---

## Current state (audited 2026-09-16)

- `organizations` table: `id`, `name` (unique, ≤100), timestamps. No domain module — only `src/domains/organizations/users/org-users.route.ts` (`DELETE /organizations/{orgId}/users/{userId}`).
- No list / create / read org endpoints anywhere. The only org-creating code path is the zero-org "solo workflow" inside `POST /projects` (`projects.route.ts:157-218`), which provisions `"<email>'s Organization"` and grants the caller Org Member + Org Manager.
- `requireSuperAdmin` middleware exists (`src/middlewares/role-auth.ts:112`) — global grant (`orgId=null, projectId=null`) holding `role:assign:org_manager`. `requirePermission(perm, () => ({}))` also resolves to global scope only (`isGrantApplicable` line 17).
- `POST /users/invite` already:
  - detects existing Fluent account vs. new user (`users.route.ts:247-284`),
  - for a new user: creates auth identity + user row + Org Member anchor + role grant, sends a magic-link email to `/accept-invitation` (201),
  - for an existing user: adds anchor + role grant to the org, sends a login-link email (200),
  - authorizes via `requirePermission(USER_CREATE, orgFromBody)` + `canAssignRole(caller, roleName, orgId, projectId)`.
  A SuperAdmin's global grant satisfies both for `roleName: 'Org Manager', projectId: null` (`authorize.test.ts:148-150` already asserts `canAssignRole(superAdmin, ORG_MANAGER, ORG, null) === true`). **No invite changes are needed for the SuperAdmin flow.**
- `GET /users` returns *all* users for SuperAdmin — not per-org — so the web org-detail page needs an org-scoped member list.
- RBAC gaps that block #489 (Org Manager self-service): Org Manager lacks `ROLE_ASSIGN_ORG_MANAGER`; `PATCH /users/:id` ignores `role`; no org-level role-change endpoint; Project Manager only exists as a project-pinned grant.
- Dev seeds (`src/db/seeds/dev-users.ts`) contain no SuperAdmin and no Org Manager.

## Sequencing

```
API-1 Org endpoints + seeds      ──► WEB-1 SuperAdmin Organizations pages + Invite Org Manager
API-2 #489 prerequisites         ──► WEB #489 Users page org roles
```

API-1 and API-2 are independent of each other. API-1 unblocks the whole onboarding flow and should go first.

---

## Ticket API-1: Organizations endpoints + SuperAdmin/Org Manager dev seeds

### Task 1: Permissions

**Files:** `src/lib/permissions.ts`, `src/db/seeds/rbac.ts`, `src/db/seeds/rbac.test.ts` (if present) / `src/lib/services/permissions/authorize.test.ts`

- [ ] Add `ORG_VIEW: 'org:view'` and `ORG_CREATE: 'org:create'` under a new `// ── Organizations` block in `PERMISSIONS`. (`authorize.ts:14` already uses `org:create` as the canonical example of an org-scoped permission.)
- [ ] Add both to `PERMISSION_DEFINITIONS` in `rbac.ts`. SuperAdmin picks them up automatically via the `Object.values(PERMISSIONS)` spread. Do **not** grant them to Org Manager in this ticket.
- [ ] Test: a global SuperAdmin grant authorizes `ORG_CREATE` at scope `{}`; an org-scoped Org Manager grant with every org-manager permission does not.

Deploy note: `seedRbac()` is idempotent; re-run `pnpm db:seed:rbac` (or the setup script) in each environment after deploy.

### Task 2: Organizations domain module

**Files (create):**

- `src/domains/organizations/organizations.types.ts`
- `src/domains/organizations/organizations.repository.ts`
- `src/domains/organizations/organizations.service.ts`
- `src/domains/organizations/organizations.service.test.ts`
- `src/domains/organizations/organizations.route.ts`

**Files (modify):** `src/app.ts` (register route import next to `org-users.route`)

**Interfaces:**

```ts
// organizations.types.ts
export const createOrganizationRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export const organizationResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  createdAt: z.string().datetime().nullable(),
});
export const organizationSummarySchema = organizationResponseSchema.extend({
  orgManagerCount: z.number().int(),  // distinct users with an Org Manager grant, projectId IS NULL
});
```

```
GET  /organizations            requireSuperAdmin (or requirePermission(ORG_VIEW, () => ({})))
                               200 organizationSummarySchema[] ordered by name
POST /organizations            requirePermission(ORG_CREATE, () => ({}))
                               201 organizationResponseSchema | 409 duplicate name | 422 validation
GET  /organizations/{orgId}    requirePermission(ORG_VIEW, () => ({}))
                               200 organizationSummarySchema | 404
```

Use `requirePermission(..., () => ({}))` rather than `requireSuperAdmin` so a future "Org Manager can read own org" only needs a scope-resolver change. Follow the `createRoute` + `server.openapi` shape and `jsonContent` / `createMessageObjectSchema` responses used in `org-users.route.ts`.

**Steps:**

- [ ] Failing service tests: `createOrganization` returns `CONFLICT` on duplicate name (mock repo → `handleConstraintError` path); `listOrganizations` returns summaries sorted by name with counts computed from `user_roles`; `getOrganization` returns `NOT_FOUND` for missing id.
- [ ] Repository: `findAllWithCounts()`, `findByIdWithCounts(id)`, `insert({ name })`. `orgManagerCount` via a single `LEFT JOIN user_roles JOIN roles` grouped query with `countDistinct(user_roles.userId)` filtered to `roles.name = 'Org Manager' AND user_roles.projectId IS NULL`.
- [ ] Service wraps repository with `Result<T>`; route maps errors via `getHttpStatus`.
- [ ] Register in `src/app.ts`.

Verify: `pnpm test src/domains/organizations`, `pnpm typecheck`, `pnpm lint`. Check `/reference` (OpenAPI) renders the new tag `Organizations`.

### Task 3: Org-scoped member list

**Files:** `src/domains/organizations/users/org-users.route.ts`, `src/domains/users/users.service.ts` (+ test)

```
GET /organizations/{orgId}/users   authenticateUser, requirePermission(USER_VIEW, orgId-from-param)
                                   200 userResponseSchema[]  (orgGrants filtered to orgId) | 404 org missing
```

- [ ] Add `getUsersInOrg(orgId)` to `users.service.ts`: `repo.findByOrganizations([orgId])` + `findRoleGrantsByUserIds(ids, [orgId])`, same shape as `getUsersForUser` output. Extract the shared mapping so both callers use it.
- [ ] Test: a user with grants in orgs 1 and 2 → only org-1 grants appear when listing org 1.
- [ ] Scope resolver reads `orgId` from the path param (same inline resolver as the DELETE route above it). Both SuperAdmin (global grant) and Org Manager (org-scoped `USER_VIEW`) pass; a Project Manager pinned to a project also has `USER_VIEW` but its grant is project-pinned, so `isGrantApplicable` rejects it at org scope — add that as a test case.

### Task 4: Invite Org Manager — verification only

No code change expected. Add a route-level or middleware-level test proving the contract the web relies on:

- [ ] `requireUserAccess(USER_ACTIONS.CREATE)` with body `{ orgId, projectId: null, roleName: 'Org Manager' }` passes for a global SuperAdmin grant and fails (403) for a project-pinned Project Manager.
- [ ] Document in the route description of `POST /users/invite` that 201 = new Fluent account created (magic link sent), 200 = existing account added to org (login link sent). The web uses the status to word its toast.
- [ ] Check the existing-user email template (`sendExistingUserOrgInviteEmail`) reads correctly when the role is Org Manager and there is no project. Adjust copy if it assumes a project.

### Task 5: Dev seeds

**Files:** `src/db/seeds/dev-users.ts`

- [ ] Add `super_admin` (global SuperAdmin grant, `orgId: null, projectId: null`) and `org_manager` (Org Member anchor + Org Manager grant in the dev org) seed users, following the existing PM pattern and password reconciliation logic. These are what QA and local dev use for both WEB-1 and #489.

### Out of scope (note in ticket)

- `PATCH /organizations/{orgId}` (rename) and `DELETE /organizations/{orgId}`.
- The zero-org "solo workflow" in `POST /projects` is **not** retired — it is the path for a solo user who registers, logs in and works without an admin, and will be refined in a later phase. API-1 must not change its behaviour. Having it call the new organizations service (one provisioning path) is a candidate for that later refinement.

---

## Ticket API-2: Prerequisites for fluent-web #489 (Org Manager self-service on the Users page)

Full task detail, including tests, lives in `fluent-web/docs/features/org-manager-users-page/plan.md` Phase A. Summary:

### Task 1: Org Manager may assign Org Manager

- [ ] `rbac.ts`: add `{ roleName: ROLES.ORG_MANAGER, permissionName: PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER }`.
- [ ] `authorize.test.ts`: org-scoped Org Manager can `canAssignRole(…, ORG_MANAGER, ORG, null)`; still cannot assign `SuperAdmin`.
- [ ] Update the comment in `requireSuperAdmin` (`role-auth.ts:121-123`): the permission is no longer SuperAdmin-exclusive, but the check still holds because it also requires a *global* grant. Add a test that an Org Manager with the new permission is still rejected by `requireSuperAdmin`.

### Task 2: Org-level role change

```
PATCH /organizations/{orgId}/users/{userId}   body { roleName: 'Org Manager' | 'Project Manager'* }
200 userResponseSchema | 400 role not allowed at org level | 403 self-change or !canAssignRole | 404 not a member
```

\* `Project Manager` only if decision D1 in the #489 plan lands on "org-level PM".

- [ ] Service `updateOrgUserRole(callerId, orgId, userId, roleName)` in `src/domains/organizations/users/org-users.service.ts`: forbid `callerId === userId`; in a transaction delete `user_roles` rows `(userId, orgId, projectId IS NULL, role ≠ Org Member)` then insert the new grant; return `usersService.getUserById(userId)`.
- [ ] Route in `org-users.route.ts`, mirroring `PATCH /projects/{projectId}/users/{userId}`.
- [ ] Tests: self-change → 403; non-member → 404; anchor + project-scoped grants preserved; idempotent when unchanged.

### Task 3 (conditional on D1): Org-level Project Manager grant

- [ ] `canAssignRole` branch 4: `PROJECT_MANAGER` with `projectId === null` requires `ROLE_ASSIGN_PROJECT` at org scope. Translator/Observer remain project-only.
- [ ] Revisit the TEMP bypass in `projects.route.ts:90-104`.

### Task 4: Optional cleanup

- [ ] `PATCH /users/:id` handler (`users.route.ts:465-475`) strips `role` after the zod schema has already dropped it — dead code. Remove or add `role` to the schema deliberately (recommend remove; role changes go through the org/project endpoints).

---

## Verification summary

| Ticket | Command |
| --- | --- |
| API-1 | `pnpm test src/domains/organizations src/domains/users src/lib/services/permissions && pnpm typecheck && pnpm lint` |
| API-2 | `pnpm test src/domains/organizations src/lib/services/permissions src/middlewares && pnpm typecheck && pnpm lint` |
| both | re-run RBAC seed in the target environment after deploy |
