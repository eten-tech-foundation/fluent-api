# Org Membership & Solo-Workflow Extension — Design Spec

**Date:** 2026-07-02
**Status:** Approved for implementation planning
**Source:** `design.md`, `plan.md`, [[2026-07-02 User Central tenant]] (meeting + Claude analysis)

## Relationship to the existing RBAC design

This spec **amends** the 2026-06-02 RBAC design; it does not replace it. The grant table (`user_roles`), the `authorize()` engine, and the "org membership is emergent" principle are all unchanged. This document closes a gap the 7/2 meeting surfaced live: the original design defines org membership as "≥1 `user_roles` row with this `org_id`," but every grant also requires a non-null `role_id` — so there was no way to represent "invited into an org, not yet given any role." It also defines the removal/cascade behavior that was left unspecified, and identifies (without fully designing) the extension point for a future solo-user workflow.

## Problem

Two gaps surfaced during the 2026-07-02 design walkthrough:

1. **Bare org membership.** An Org Manager needs to invite a person into an org before that person has any project to be assigned to. Roles, by design, are scoped to a project (or are the org-wide `Org Manager` role) — there is no role that means "just a member." Without one, either the schema needs a nullable `role_id` (which breaks the "grant = role + permission set" invariant everywhere else) or invited-but-unassigned users can't be represented at all.
2. **Solo workflow.** A user should be able to register and start a project for their own church without an org or team pre-existing. The application has deep assumptions about separate drafter/checker/reviewer roles that make a _fully_ solo translation pipeline out of scope for now — but registration and project creation should not be architecturally blocked on "someone else set up an org for you first."

## Goals

- Represent org membership without requiring a functional role, using the existing grant model — no new tables, no nullable `role_id`.
- Guarantee that a user's org membership survives changes to their project-level grants (being removed from a project must never silently evict them from the org).
- Provide two distinct, consistently-behaved removal operations: remove-from-project and remove-from-org.
- Leave a clear, low-risk extension point for self-service org/project creation, without committing to a full solo-translation-pipeline design now.

## Non-Goals

- Designing the solo translator/checker workflow (single person performing drafting, peer-check, and review alone). Deferred; see Open Items.
- Changing the `authorize()` engine, the `Grant`/`AuthScope` types, or the unique constraint on `user_roles`. All unchanged from the 2026-06-02 design.
- Revisiting the full Org Manager permission set narrowing flagged in the 7/2 meeting analysis — that is a separate, already-tracked follow-up to the RBAC seed (Task 16 of the implementation plan). This spec assumes that narrower Org Manager permission set is applied but does not redefine it here.

## Core Insight — Membership Is a Grant With No Permissions

The existing model already treats permissions as a property of the _grant_, not the _role name_. Extending that one step further: a role can exist purely to mark presence, carrying zero permissions. That role is a first-class `roles` row like any other — `authorize()` needs no special case, no null-checks, and no second membership table.

## Data Model

### New seeded role: `Org Member`

Added to `ROLES` and seeded with **no entries in `role_permissions`**. A grant of this role never satisfies any `authorize()` check — it exists only so a `user_roles` row can exist.

```ts
export const ROLES = {
  SUPER_ADMIN: 'SuperAdmin',
  ORG_MANAGER: 'Org Manager',
  ORG_MEMBER: 'Org Member', // new
  PROJECT_MANAGER: 'Project Manager',
  PROJECT_TRANSLATOR: 'Project Translator',
  PROJECT_OBSERVER: 'Project Observer',
} as const;
```

Org Owner is removed.

(`Org Owner` is omitted here per the 7/2 decision to collapse it into `Org Manager` — tracked as part of the Task 16 permission-map follow-up, not redefined in this doc.)

### The anchor row

Inviting a user into an org (an Org Manager action) creates exactly one grant:

```text
(user, org_id, project_id: null, role: Org Member)
```

This is the **anchor row**. Its only job is to make the user emergent-a-member of the org — i.e., visible in that org's user list, invitable to any project within it.

### Anchor rows are never updated — only added alongside

When a user is later given a real role (a project-scoped grant, or promotion to `Org Manager`), a **new grant row is inserted**. The anchor row is left untouched.

```text
(user, org, null, OrgMember)          <- anchor, created at invite time, never modified
(user, org, project, ProjectManager)  <- added when granted; can be removed independently
```

This is unique-constraint-safe: the anchor and any work grant differ in `project_id` and/or `role_id`, so they never collide under `uq_user_role_grant`.

**Why this matters:** if a project grant were instead created by _mutating_ the anchor row, then later revoking that grant would delete the user's only `user_roles` row in that org — and since org membership is emergent ("≥1 row with this `org_id`"), the user would silently fall out of the org. Keeping the anchor separate and permanent means project-level grants can be freely added and removed without ever affecting org membership.

### Repository changes

- `findGrantsByUserId` — unchanged; `Org Member` grants simply contribute an empty permission set and are harmless no-ops in `collectPermissions`.
- New: `inviteUserToOrg(userId, orgId, createdBy)` in `user-roles.service.ts` — thin wrapper that calls `grantRole({ userId, orgId, projectId: null, roleId: getRoleId(ROLES.ORG_MEMBER), createdBy })` with `onConflictDoNothing` (idempotent — inviting an already-member user is a no-op, not an error).
- The org's "invitable users" / user-list query is unchanged: any user with a `user_roles` row where `org_id = O` (anchor or otherwise) is a member of O.

## Removal — Two Operations, Consistent Behavior, Auto-Unassign

Both removal operations **unassign the user's active work first, then delete grants** — they do not block on active assignments. The UI is responsible for warning the actor clearly before the action is taken (see UI Behavior below).

### Remove from project

**Trigger:** PM/Org Manager action on a project's user table.

**Steps (single transaction):**

1. Clear the user as `assignedUserId` (drafter) and `peerCheckerId` on every `chapter_assignments` row in that project where they're currently assigned.
2. Delete the project-scoped `user_roles` grant(s) for that user in that project.

**Result:** the user loses access to the project; any chapter assignments they held are now unassigned (blank drafter/peer-checker), surfaced by the existing drafter/peer-checker sort & filter (already planned per the 7/2 ticket list) so the PM can quickly find and reassign them. Org membership (the anchor row) is untouched.

### Remove from org

**Trigger:** Org Manager action on the org's users page.

**Steps (single transaction):**

1. Across **every project in the org**, clear the user as `assignedUserId`/`peerCheckerId` wherever they're currently assigned (same unassign logic as project removal, applied org-wide).
2. Delete **every** `user_roles` grant that user holds with this `org_id` — the anchor row and every project-scoped or org-scoped grant.

**Result:** the user is fully disassociated from the org (per the 7/2 decision: "it just disassociates them from the org... not gonna delete any of their data or their account"). Their account, and any grants in _other_ orgs, are unaffected.

Both operations share one implementation: `unassignActiveWork(userId, projectIds[])` + a grant-deletion step scoped to either one project or the whole org. Remove-from-org is remove-from-project applied to the full set of the org's project IDs, plus the anchor.

### UI behavior (both operations)

Before either removal executes, the UI must show a confirmation dialog stating plainly what will happen — explicitly naming any assignments that will be cleared (e.g., "Jamie is currently the drafter on 3 chapters and peer-checker on 1. Removing them will unassign this work. Continue?"). No silent unassignment. This mirrors the existing confirmation-step pattern already used for other destructive actions in the app.

## Solo-Workflow Extension Point (Deferred)

Registration does **not** auto-create an org for a new user. A newly registered user exists with zero `user_roles` rows.

The extension point is at **project creation**: when a user with no existing org hits "create project," the service layer provisions a personal org and grants that user `Org Manager` **and** `Project Manager` on it, in the same transaction that creates the project (reusing the existing auto-assign-creator-as-PM logic from Task 11 of the RBAC plan — no new grant-issuing code path is needed, just a preceding "does this user have zero orgs; if so, create one first" check).

This makes a solo user structurally identical to a small team where one person happens to hold every relevant role — no new permission concepts, no schema changes beyond what's already specified. It deliberately does **not** attempt to solve the separate drafter/peer-checker/reviewer assumptions baked into the chapter-assignment workflow; a solo user would need to hold `Project Translator` as well and interact with a pipeline still modeled around distinct people. That gap is called out explicitly below rather than papered over.

## Testing

- **Unit:** `Org Member` grants contribute no permissions to `collectPermissions` (regression test against the existing `authorize.test.ts` suite — a user with only an `Org Member` grant is denied every permission check).
- **Unit:** anchor-row survival — grant a project-scoped role, then revoke it; assert the anchor row (and therefore emergent org membership) still exists.
- **Integration:** remove-from-project clears `assignedUserId`/`peerCheckerId` on affected chapter assignments and deletes only the project-scoped grant; org membership (anchor + other project grants) is unaffected.
- **Integration:** remove-from-org clears assignments across every project in the org and deletes all grants including the anchor; grants in other orgs are unaffected.
- **Integration:** inviting an already-member user (`inviteUserToOrg` called twice) is idempotent — no duplicate row, no error.

## Open Items

- **Org Manager permission narrowing** (view-only on projects, no content edit) is assumed but not redefined here — tracked against Task 16 of the existing RBAC implementation plan.
- **Solo translation pipeline** (single person performing drafting, peer-check, and consultant review without triggering workflow states designed for separate people) is explicitly deferred. The schema does not block it, but the chapter-assignment status machine and UI will need their own design pass before a fully solo project is usable end-to-end.
- **UI copy/flow for the two removal confirmations** (exact wording, how assignment counts are surfaced) is a follow-up UI ticket, not specified here.
