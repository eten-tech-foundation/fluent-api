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
- `GET /users` returns _all_ users for SuperAdmin — not per-org — so the web org-detail page needs an org-scoped member list.
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
  orgManagerCount: z.number().int(), // distinct users with an Org Manager grant, projectId IS NULL
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

**Implemented on `feat/org-manager-self-service`.** Product decisions (2026-09-16): **D1 = Option (b)** — org-level roles only on the Users page (`Org Manager` to promote, `Org Member` to demote); no org-level PM, so Task 3 was dropped. **D2** — self-change block is the last-OM guard; DELETE also rejects self-removal. **D3** — role display precedence is web-side.

Full task detail, including tests, lives in `fluent-web/docs/features/org-manager-users-page/plan.md` Phase A. Summary:

### Task 1: Org Manager may assign Org Manager

- [x] `rbac.ts`: added `{ roleName: ROLES.ORG_MANAGER, permissionName: PERMISSIONS.ROLE_ASSIGN_ORG_MANAGER }`.
- [x] `authorize.test.ts`: org-scoped OM can assign OM (not SuperAdmin, not cross-org); project-pinned `role:assign:org_manager` can't satisfy org scope.
- [x] `requireSuperAdmin` comment updated; new `role-auth.test.ts` proves an OM holding the org-scoped permission is still rejected.

### Task 2: Org-level role change

```
PATCH /organizations/{orgId}/users/{userId}   body { roleName: 'Org Manager' | 'Org Member' }
200 userResponseSchema | 400 not a member | 403 self-change or !canAssignRole
```

- [x] `org-users.service.ts` + `repo.updateOrgUserRole`: forbid `callerId === userId`; require org membership (`findUserIdsInOrg`); transaction replaces the non-anchor org-level grant (or deletes it on demote), keeping the `Org Member` anchor and all project-scoped grants; idempotent when unchanged.
- [x] Route in `org-users.route.ts` with `requirePermission(USER_UPDATE, org-scope)` + `canAssignRole` in the handler. DELETE org-user now also blocks `caller.id === userId` (self-removal → 403).

### Task 3: ~~Org-level Project Manager grant~~ — dropped per D1 (b)

### Task 4: Cleanup

- [x] Removed the dead `updates.role` strip (and now-unused `authorize` import) from `PATCH /users/:id`.

---

## Verification summary

| Ticket | Command                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| API-1  | `pnpm test src/domains/organizations src/domains/users src/lib/services/permissions && pnpm typecheck && pnpm lint` |
| API-2  | `pnpm test src/domains/organizations src/lib/services/permissions src/middlewares && pnpm typecheck && pnpm lint`   |
| both   | re-run RBAC seed in the target environment after deploy                                                             |
