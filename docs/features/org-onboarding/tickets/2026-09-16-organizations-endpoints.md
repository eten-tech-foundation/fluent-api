# Organizations endpoints for SuperAdmin org onboarding + dev seeds

> **Status: IMPLEMENTED** — PR [fluent-api#339](https://github.com/eten-tech-foundation/fluent-api/pull/339).
> GitHub: [fluent-api#336](https://github.com/eten-tech-foundation/fluent-api/issues/336)

**Parent feature:** [`org-onboarding`](../plan.md) — Ticket API-1.
**Repo:** `fluent-api`.
**Unblocks:** fluent-web#492 (SuperAdmin Organizations pages).
**Blocked by:** nothing.

## Problem

A SuperAdmin must be able to create a new organization and invite its first Org Manager without a developer. The API has no list / create / read org endpoints and no org-scoped member list (`GET /users` returns _all_ users for a SuperAdmin). The only org-creating code is the zero-org "solo workflow" inside `POST /projects`, which serves solo users and is out of scope here.

`POST /users/invite` already covers the invite step: it detects new vs. existing Fluent accounts, grants Org Member anchor + role, and emails a magic link (201) or login link (200). `canAssignRole(superAdmin, 'Org Manager', orgId, null)` is already `true` (`authorize.test.ts:148-150`). No invite changes are expected beyond tests and docs.

## Scope decisions

- Endpoints use `requirePermission(perm, () => ({}))` (global scope) rather than `requireSuperAdmin`, so a future "Org Manager reads own org" is a scope-resolver change only.
- List/read summary carries `orgManagerCount` only. No `memberCount`: the web list shows Name / Org Managers / Created and the detail page lists members directly.
- The zero-org solo workflow in `POST /projects` is **not** retired and its behaviour must not change in this ticket. It is the solo-user path and will be refined in a later phase.

## Tasks

### 1. Permissions

Files: `src/lib/permissions.ts`, `src/db/seeds/rbac.ts`, `src/lib/services/permissions/authorize.test.ts`

- [ ] Add `ORG_VIEW: 'org:view'` and `ORG_CREATE: 'org:create'` under a new `// ── Organizations` block.
- [ ] Add both to `PERMISSION_DEFINITIONS`. SuperAdmin gets them via the existing all-permissions spread. Do not grant to Org Manager.
- [ ] Test: global SuperAdmin grant authorizes `ORG_CREATE` at scope `{}`; an org-scoped Org Manager grant does not.

### 2. Organizations domain module

Create: `src/domains/organizations/organizations.{types,repository,service,route}.ts`, `organizations.service.test.ts`. Modify: `src/app.ts`.

```ts
export const createOrganizationRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export const organizationResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  createdAt: z.string().datetime().nullable(),
});
export const organizationSummarySchema = organizationResponseSchema.extend({
  orgManagerCount: z.number().int(), // distinct users with Org Manager grant, projectId IS NULL
});
```

```
GET  /organizations          requirePermission(ORG_VIEW, () => ({}))    200 summary[] ordered by name
POST /organizations          requirePermission(ORG_CREATE, () => ({}))  201 org | 409 duplicate name | 422 validation
GET  /organizations/{orgId}  requirePermission(ORG_VIEW, () => ({}))    200 summary | 404
```

- [ ] Failing service tests: duplicate name → `CONFLICT` (via `handleConstraintError`); list sorted by name with `orgManagerCount`; missing id → `NOT_FOUND`.
- [ ] Repository: `findAllWithCounts()`, `findByIdWithCounts(id)`, `insert({ name })`. Count via `LEFT JOIN user_roles JOIN roles`, `countDistinct(user_roles.userId)` filtered to `roles.name = 'Org Manager' AND user_roles.projectId IS NULL`.
- [ ] Service returns `Result<T>`; route maps errors with `getHttpStatus`. Follow the `createRoute` + `server.openapi` + `jsonContent` shape in `org-users.route.ts`.
- [ ] Register the route import in `src/app.ts` next to `org-users.route`.

### 3. Org-scoped member list

Files: `src/domains/organizations/users/org-users.route.ts`, `src/domains/users/users.service.ts` (+ test)

```
GET /organizations/{orgId}/users   requirePermission(USER_VIEW, orgId from path)   200 userResponseSchema[] | 404
```

- [ ] `getUsersInOrg(orgId)` in `users.service.ts`: `repo.findByOrganizations([orgId])` + `findRoleGrantsByUserIds(ids, [orgId])`; extract the mapping shared with `getUsersForUser`.
- [ ] Tests: grants in orgs 1 and 2 → only org-1 grants returned for org 1; project-pinned Project Manager is rejected at org scope (its `USER_VIEW` grant is not applicable); SuperAdmin and org-scoped Org Manager pass.

### 4. Invite Org Manager — verification only

- [ ] Test `requireUserAccess(USER_ACTIONS.CREATE)` with body `{ orgId, projectId: null, roleName: 'Org Manager' }`: passes for a global SuperAdmin grant, 403 for a project-pinned PM.
- [ ] Route description of `POST /users/invite`: document 201 = new account created (magic link), 200 = existing account added to org (login link).
- [ ] Check `sendExistingUserOrgInviteEmail` copy reads correctly with no project context; adjust if it assumes one.

### 5. Dev seeds

File: `src/db/seeds/dev-users.ts`

- [ ] Add `super_admin` (global grant, `orgId: null, projectId: null`) and `org_manager` (Org Member anchor + Org Manager grant in the dev org), following the PM pattern and password reconciliation.

## Verification

```
pnpm test src/domains/organizations src/domains/users src/lib/services/permissions
pnpm typecheck && pnpm lint
```

Check `/reference` renders the `Organizations` tag. After deploy, re-run `pnpm db:seed:rbac` (or the setup script) in each environment.

## Out of scope

- `PATCH` / `DELETE /organizations/{orgId}`.
- Any change to the solo workflow in `POST /projects`.
