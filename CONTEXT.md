# Fluent API

Backend API for the Fluent Bible-translation platform: organizations run translation Projects whose chapters move through workflow phases via Chapter Assignments, governed by scoped role grants.

## Language

**Organization**:
A translation organization that owns projects and memberships. Users join an Organization via an `Org Member` anchor grant; a user may belong to several Organizations (the multi-org switcher).
_Avoid_: tenant, team, account

**Project**:
A source→target language-pair translation effort inside one Organization, grouping its books into Milestones.
_Avoid_: unit of work

**Milestone**:
A named group of books inside a Project (a `project_units` row) — e.g. "Gospel of Mark" under "Koli Kachi New Testament". Carries a `type` (`text` or `audio`), a `status`, and an optional `connectivityProfile`; owns the book links and Chapter Assignments beneath it.
_Avoid_: unit, project unit (legacy table name)

**Chapter Assignment**:
The unit of work inside a Milestone: one (milestone, bible, book, chapter) row carrying a workflow `status`, an `assignedUserId`, and an optional `peerCheckerId`.
_Avoid_: task, ticket

**Phase**:
A display grouping of `chapter_status` values shown on progress bars: Drafting (`draft`), Peer Check (`peer_check`), Community Review (`community_review`), Advanced Checks (`linguist_check` + `theological_check` + `consultant_check`), Complete (`complete`), plus Not Started (`not_started`).
_Avoid_: stage, step (the enum value is the status; the Phase is the UI grouping)

**Role Grant**:
A row in `user_roles` giving a user a Role at a scope: global (no org/project — SuperAdmin), org-scoped (`orgId` set — Org Member, Org Manager), or project-scoped (`orgId` + `projectId` set — Project Manager, Project Translator, Project Observer).
_Avoid_: permission, membership (Org Member is one specific Role Grant, not a synonym for all of them)

**Seed User**:
An account created by the seed pipeline from an environment's spec — a `users` row plus its better-auth `auth_user`/`auth_account` credential rows and Role Grants.
_Avoid_: test user, fixture user

**Reference Data**:
Environment-neutral seeded rows identical across local/dev/qa: roles, RBAC permissions, languages, books, the IRV bible and its texts, pericope sets. Seeded by `setup.ts` steps 2–9.
_Avoid_: fixtures, static data

**Demo Spec**:
The declarative per-environment seed (`src/db/seeds/demo/` — `qa-spec.ts` for QA, `dev-spec.ts` shared by dev/local) describing the demo world: organizations, Seed Users, projects, milestones, and chapter assignments for stakeholder demos and QA.
_Avoid_: seed data (ambiguous — Reference Data is also seed data)

**Reconcile**:
What seed functions do on re-run: create-if-missing, update drifted fields (e.g., rotate a Seed User's password hash, backfill Role Grants), never delete.
_Avoid_: upsert (too generic), reset

**Reset**:
`db:reset:<env>` — drop the application schemas (`public`, `drizzle`, `pgboss`; never `ai`), re-run migrations, re-seed everything. A full clean slate: no non-seed data survives.
_Avoid_: reseed (ambiguous with Reconcile), refresh
