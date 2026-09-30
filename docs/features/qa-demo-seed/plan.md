# fluent-api: QA Demo Seed & Clean-Slate Reset Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the QA (staging) environment a one-command, deterministic reset: drop all application data, re-run migrations, and reseed a fixed demo world — 4 organizations, 17 user accounts, 3 projects holding 4 milestones with chapter assignments spread across every workflow phase — where every account logs in with a known password that requires **zero manual setup**. The same reset script also serves `dev`, and the same seed engine brings **dev and local** onto the correct grant model (project-level roles pinned to projects, not the org).

**Architecture:** A new `reset-db.ts` script drops/recreates the `public`, `drizzle`, and `pgboss` schemas (as `api_migrator` via `MIGRATIONS_DATABASE_URL`) behind an interactive confirmation, then shells out to the existing `setup.ts` so the entire seed pipeline is reused unchanged. Demo/demo-adjacent content lives in a declarative spec format (`DemoSpec`) interpreted by a shared engine (`src/db/seeds/demo/`): `qa.ts` gets the full QA spec; `dev.ts` and `local.ts` get a small spec (a single project on the already-seeded IRV Gujarati bible, so dev/local get real source text with zero new data files). `setup.ts` calls the engine when the env-config provides a `demoSpec`. Passwords: QA uses a committed better-auth hash string (generated offline via a new `db:hash-password` utility — no plaintext in repo, no env vars, no post-seed `db:set-password`); dev keeps its env-var plaintext model (`DEV_PM_*`/`DEV_SEED_PASSWORD`); local keeps committed plaintext.

**Tech Stack:** TypeScript, tsx, Drizzle ORM, better-auth (`hashPassword`/`verifyPassword` scrypt format), postgres.js (raw DDL for schema drops).

> **Revision note (post-milestones):** This plan was written before the Milestones model landed on `main` (migration `0029_add_milestones`). `project_units` are now first-class **Milestones** — named, typed (`'text' | 'audio'`), with `connectivityProfile` and their own `status`; `projects` gained `sourceBibleId` and `pericopeSetId`; `project_unit_bible_books` is soft-deletable (`deletedAt`) with PK `(project_unit_id, book_id)`. The spec and engine below are already expressed in the milestone model — the demo world is seeded directly in the grouped shape the old Follow-On 5 anticipated, so no regroup is ever needed.

## Global Constraints

- **No plaintext passwords in the repo** — not in seed files, comments, docs, or `.env.example`. Only hash strings produced by better-auth's `hashPassword` are committed.
- **No plaintext passwords in chat/tickets** — the developer generates hashes locally via `npm run db:hash-password` and commits the output.
- **Reset is destructive and manual-only** — `db:reset:*` must print the target host + database name and require the operator to type the database name to proceed. No `--yes`/`--force` flag (CI does not use this command).
- **`SETUP_ENV` guard** — `reset-db.ts` accepts only `dev` and `qa`. Local Docker resets happen via `docker compose down -v`, not this script.
- **The `ai` schema is never dropped** — it belongs to the AI service (`ai_migrator`/`ai_user`), is outside the API's seed concern, and `setup.ts` does not populate it.
- **All demo seed writes are idempotent upserts** — the demo seed must be safe to run standalone (`db:seed:demo:<env>`) against a populated DB without duplicating rows, even though the primary path is post-reset.
- **Specs mirror the post-milestone hierarchy** — Project → Milestones (`project_units` rows, with `name`/`type`/`status`) → book links (`project_unit_bible_books`, `deletedAt`-aware) → Chapter Assignments (`projectUnitId` + `bibleId` + `bookId` + `chapterNumber`). Book membership is project-wide unique: one book can be actively linked to only one milestone per project.
- **Reference data stays env-neutral** — `languages.json`, `books.json`, `bible-texts.json`, and the IRV bible seed are unchanged. Demo-specific reference rows (`nya`, `wol`, BSB, WEB) are upserted by the demo seed, not added to the shared seed data files.
- **Grants mirror the real RBAC model** — `user_roles` scoping matches app behavior exactly, for every environment:
  - `Org Member` — org-scoped anchor (`orgId` set, `projectId` NULL); every org member has exactly one per org.
  - `Org Manager` — org-scoped (`orgId` set, `projectId` NULL). This is the only non-global grant that satisfies org-scoped permission checks like `project:create` (see `authorize.ts`'s `isGrantApplicable` — project-pinned grants never satisfy org-scoped checks).
  - `Project Manager` / `Project Translator` / `Project Observer` — **project-scoped** (`orgId` + `projectId` set), mirroring `bulkAddUsersToProject`. Never org-scoped. The existing `seedDevUsers` org-level PM grant is the old pattern and is corrected by this plan.
  - `SuperAdmin` — a single global grant (`orgId` NULL, `projectId` NULL) with **no** org memberships.
  - Context: `projects.route.ts` carries a `TEMP` bypass letting project-pinned PM grants satisfy `project:create`, explicitly marked for removal once QA has real org-manager accounts — this seed work is what makes that removal possible (tracked as a follow-on; removing the bypass is NOT in this plan).

## Decisions Locked From Design Sessions

- Reset semantics: **full clean slate** — nothing created outside the seeds survives.
- Credentials: one shared password for **all** QA accounts (`qa+*@fluent.local` and `cwhite+*@gloo.us`); committed hash; user generates the hash locally. Dev keeps env-var passwords; local keeps committed plaintext.
- Grant pattern (applies to **all** environments' seeds): org membership = `Org Member` anchor; org-level roles = `Org Manager` org-scoped; project-level roles (PM/Translator/Observer) = project-scoped only.
- SuperAdmin (`cwhite@gloo.us`) holds _only_ the global grant — no org/project roles anywhere.
- Phase mapping (spec "five phases" → `chapter_status` enum): Drafting→`draft`, Peer Check→`peer_check`, Community Review→`community_review`, Advanced Checking→spread across `linguist_check`/`theological_check`/`consultant_check` (the web UI collapses these into one "Advanced Checks" segment with sub-segments), Complete→`complete`. `not_started` is used only where a chapter should visibly show as untouched.
- Demo accounts (`cwhite+*@gloo.us`) are real deliverable plus-aliases — intentional, so invite/password-reset email flows can be demoed.
- **Demo projects are seeded in the milestone-grouped shape** — project = language-level effort, books grouped into named milestones (the shape `db:consolidate:projects` would converge to anyway). The OBT milestone is `type='audio'`; all others `type='text'`.
- Explicit follow-ons (NOT in this plan): BSB/WEB verse text (user supplies data file), DBL `externalId` + audio wiring for the OBT project (user has creds, will trigger), AI-suggestions corpus for `gjk` (needs its own spec — no large fake-data commit to the repo).

## The Demo Spec (content that must be encoded)

### Organizations (4)

| Key            | Name                             | Character                                                          |
| -------------- | -------------------------------- | ------------------------------------------------------------------ |
| `fluent-qa`    | Fluent QA                        | Scratch org for general QA accounts; **no seeded projects**        |
| `highland`     | Highland Translation Alliance    | Large/established; 2 projects, 2 target languages, text + OBT      |
| `rivertown`    | Rivertown Translation Team       | Small/established; 1 project, 1 language pair, text-only           |
| `new-horizons` | New Horizons Translation Project | Brand-new/blank; OM only, no projects — demos first-run/onboarding |

### Users (17 rows)

All accounts share one password → one shared `passwordHash` constant in the spec.

| Key          | Email                                | Org memberships     | Role grants                                                                                                                               |
| ------------ | ------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `qa-om`      | qa+FluentQA-om@fluent.local          | fluent-qa           | Org Manager (org-scoped, fluent-qa) — this is the account that creates projects in Fluent QA                                              |
| `qa-pm`      | qa+FluentQA-pm@fluent.local          | fluent-qa           | anchor only — PM is project-scoped and Fluent QA seeds no projects; QA assigns it via the real UI flow                                    |
| `qa-t1`      | qa+FluentQA-translator@fluent.local  | fluent-qa           | —                                                                                                                                         |
| `qa-t2`      | qa+FluentQA-translator2@fluent.local | fluent-qa           | —                                                                                                                                         |
| `qa-obs`     | qa+FluentQA-observer@fluent.local    | fluent-qa           | —                                                                                                                                         |
| `superadmin` | cwhite@gloo.us                       | none                | **SuperAdmin (global) — only grant this user has**                                                                                        |
| `hi-om`      | cwhite+highland-om@gloo.us           | highland            | Org Manager (highland)                                                                                                                    |
| `hi-pm`      | cwhite+highland-pm@gloo.us           | highland, rivertown | Project Manager project-scoped on both highland projects **and** on rivertown's project — cross-org account for the org-switcher demo      |
| `hi-t`       | cwhite+highland-translator@gloo.us   | highland            | Translator (project-scoped: `highland-nt`)                                                                                                |
| `hi-obs`     | cwhite+highland-observer@gloo.us     | highland            | Observer (project-scoped: both highland projects)                                                                                         |
| `hi-mt1`     | cwhite+highland-mob-t1@gloo.us       | highland            | Translator (project-scoped: both highland projects — text + OBT)                                                                          |
| `hi-mt2`     | cwhite+highland-mob-t2@gloo.us       | highland            | Translator (project-scoped: both highland projects — text + OBT)                                                                          |
| `hi-mobs`    | cwhite+highland-mob-obs@gloo.us      | highland            | Observer (project-scoped: both highland projects)                                                                                         |
| `rt-om`      | cwhite+rivertown-om@gloo.us          | rivertown           | Org Manager (rivertown)                                                                                                                   |
| `rt-t`       | cwhite+rivertown-translator@gloo.us  | rivertown           | Translator (project-scoped: `wolof-epistles`)                                                                                             |
| `rt-obs`     | cwhite+rivertown-observer@gloo.us    | rivertown           | Observer (project-scoped: `wolof-epistles`)                                                                                               |
| `nh-om`      | cwhite+newhorizons-om@gloo.us        | new-horizons        | Org Manager (new-horizons)                                                                                                                |

Every user except `superadmin` also gets the `Org Member` anchor grant per org membership (matches existing `dev-users.ts` convention). `users.status='verified'`, `authUser.emailVerified=true`, `createdBy` = the org's Org Manager where one exists (the realistic project-creating actor), else `superadmin`.

### Dev/Local spec (same engine, smaller world)

`dev.ts` and `local.ts` each get a `demoSpec` built by a shared `devSpec(credentials)` factory — dev passes env-var credentials (`DEV_PM_EMAIL`/`DEV_PM_PASSWORD`/`DEV_SEED_PASSWORD`, hashed at seed time), local passes its hardcoded plaintext defaults. Content:

- Org: `Fluent Dev` (the existing `orgName`).
- Users (existing roster, re-granted to the correct pattern): `devpm` → PM project-scoped on the demo project; `alice.smith`, `bob.johnson`, `carol.davis` → Translator project-scoped on it. Local equivalents: `devpm`, `translator`, `translator2`.
- One project: `Gujarati → English — Genesis & Exodus`, source `guj` (IRV bible — real verse text already seeded via `bible-texts.json`, so dev gets a working source panel for free), target `eng`, `pericopeSet: 'FIA'`, one text milestone `Genesis & Exodus` holding GEN+EXO, chapters round-robined across the translators with a modest phase spread (draft/peer_check/complete is enough — dev doesn't need the full demo matrix).

### Projects (3 — milestone model)

| Org       | Key              | Project                    | Source→Target | Bible       | Milestones (type → books)                                     |
| --------- | ---------------- | -------------------------- | ------------- | ----------- | ------------------------------------------------------------- |
| highland  | `highland-nt`    | Koli Kachi New Testament   | eng→gjk       | BSB         | `Gospel of Mark` (text → MRK 16), `Gospel of John` (text → JHN 21) |
| highland  | `chichewa-obt`   | Chichewa Oral Bible        | eng→nya       | WEB (audio) | `Old Testament Narratives` (audio → RUT 4, JON 4)             |
| rivertown | `wolof-epistles` | Wolof General Epistles     | eng→wol       | BSB         | `Book of James` (text → JAS 5)                                |

- `projects.sourceBibleId` set to the spec's `sourceBible`; `projects.pericopeSetId` set via spec `pericopeSet: 'FIA'` on all three (`seedPericopeSets` auto-assigns FIA to any project with NULL — seeding it directly keeps the demo seed deterministic regardless of run order).
- Milestones are `project_units` rows: `name`/`type` from the spec, `status='in_progress'` (all have active chapter work); `connectivityProfile` set on the audio milestone to demo the field (freeform varchar — use `'low-bandwidth'`).
- One `project_unit_bible_books` link row per (milestone, book), carrying the project's `sourceBibleId` — the same shape `createMilestone` writes. Reconcile restores soft-deleted links (`deletedAt` → NULL) rather than inserting duplicates.
- `projects.status='active'`, `projects.createdBy` = the project's PM.
- `isAiEnabled=true` on `highland-nt` chapter assignments (Koli Kachi is the AI-suggestions demo pair).

### Chapter assignment & status distribution

- **Mark (16):** draft×3, peer_check×3, community_review×3, linguist_check×2, theological_check×1, consultant_check×1, complete×3. Chapters split across `hi-t`, `hi-mt1`, `hi-mt2`; `hi-mt1`↔`hi-mt2` are each other's `peerCheckerId` on the chapters they own.
- **John (21):** draft×4, peer_check×4, community_review×4, linguist_check×2, theological_check×1, consultant_check×1, complete×5. Same assignment pattern as Mark.
- **Chichewa (8):** draft×2, peer_check×2, community_review×1, linguist_check×1, consultant_check×1, complete×1. All chapters owned by `hi-mt1`/`hi-mt2` (mobile audio workflow), peer-checking each other.
- **James (5):** one chapter each of draft, peer_check, community_review, consultant_check, complete — all to `rt-t`.
- Exact chapter→user/status lists are produced by a small deterministic `spread()` helper in `qa-spec.ts` (round-robin over statuses then users), not hand-enumerated — the counts above are the acceptance criteria.

### Reference rows the demo seed upserts

- Languages: `nya` (Chichewa), `wol` (Wolof) — `onConflictDoNothing` on `langCodeIso6393`.
- Bibles: `BSB` (Berean Standard Bible, eng) linked to MRK/JHN/JAS via `bible_books`; `WEB` (World English Bible, eng, `bibles.hasAudio=true`) linked to RUT/JON. `externalId` left NULL until the DBL ids are supplied (follow-on) — audio UI renders, playback degrades gracefully without it. **The `bible_books` links are required before milestone creation** — the app validates milestone bookIds against them (`getValidBookIdsForBible`).
- Bible text: none in this plan — `bible_texts` rows for these bibles land with the follow-on data file (see Follow-Ons).

## File Structure

- Create: `src/db/scripts/hash-password.ts` — CLI that prints a better-auth password hash (Task 1)
- Create: `src/db/scripts/reset-db.ts` — confirm-gated schema drop + delegated setup (Task 2)
- Create: `src/db/seeds/demo/types.ts` — `DemoSpec`/`DemoUser`/`DemoProject`/`DemoMilestone`/`DemoBook`/`DemoGrant` types (Task 3)
- Create: `src/db/seeds/demo/qa-spec.ts` — the QA spec above (Task 3)
- Create: `src/db/seeds/demo/dev-spec.ts` — `devSpec(credentials)` factory serving `dev.ts` and `local.ts` (Task 3)
- Create: `src/db/seeds/demo/index.ts` — `seedDemoSpec(spec)` engine (Tasks 4–6)
- Create: `src/db/seeds/demo/data/` — home for follow-on bible-text JSON (empty now)
- Modify: `src/db/env-configs/types.ts` — `EnvConfig.demoSpec?: DemoSpec`; widen `SeedUser.role` union (Task 3)
- Modify: `src/db/env-configs/qa.ts` — remove `QA_PM_*` getters, export `demoSpec: qaSpec` (Task 3)
- Modify: `src/db/env-configs/dev.ts` — `demoSpec: devSpec(envCreds)`; `seedUsers` getter retires (Task 3)
- Modify: `src/db/env-configs/local.ts` — `demoSpec: devSpec(localCreds)` (Task 3)
- Modify: `src/db/seeds/dev-users.ts` — becomes the shared user+grant writer: accepts `passwordHash`, per-user org memberships + org-scoped + project-scoped grants (Task 5)
- Modify: `src/db/scripts/setup.ts` — step 10: `if (config.demoSpec) await seedDemoSpec(config.demoSpec)` (Task 7)
- Modify: `package.json` — `db:hash-password`, `db:reset:dev`, `db:reset:qa`, `db:seed:demo:dev`, `db:seed:demo:qa` (Tasks 1, 2, 7)
- Modify: `docs/db-provisioning-and-setup.md` — document reset command + demo seed (Task 8)
- Create: `CONTEXT.md` — glossary (done alongside this plan)
- Create: `docs/adr/0001-qa-demo-seed-credentials-and-reset.md` — done alongside this plan

---

### Task 1: `db:hash-password` utility

**Files:** Create `src/db/scripts/hash-password.ts`; Modify `package.json`

- [ ] **Step 1:** Script reads `process.argv[2]`, calls `hashPassword` from `better-auth/crypto`, prints the hash. Usage line on missing arg. Mirror `set-password.ts` structure.
- [ ] **Step 2:** Add `"db:hash-password": "npx tsx src/db/scripts/hash-password.ts"` to package.json scripts.
- [ ] **Step 3:** Verify: `npm run db:hash-password test123` prints a hash; paste output through `verifyPassword` in a `tsx -e` one-liner to confirm it verifies.
- [ ] **Step 4:** Hand to user — they run it on the real shared password and return only the hash string for Task 3's `QA_DEMO_PASSWORD_HASH` constant.

### Task 2: `db:reset:dev` / `db:reset:qa`

**Files:** Create `src/db/scripts/reset-db.ts`; Modify `package.json`

- [ ] **Step 1:** Resolve `SETUP_ENV` — accept only `dev|qa`, exit 1 otherwise with a message pointing local users at `docker compose down -v`.
- [ ] **Step 2:** Load `src/db/env-configs/<env>.ts`; require `MIGRATIONS_DATABASE_URL` (DDL-capable `api_migrator`), error if unset.
- [ ] **Step 3:** Print masked URL + parsed db name; `readline` prompt requiring the operator to type the exact database name to continue; abort on mismatch.
- [ ] **Step 4:** As one postgres.js connection: `DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public; CREATE SCHEMA pgboss AUTHORIZATION api_user;` — identifiers quoted server-side via `quote_ident` (same pattern as `provision-db.ts`). Do NOT touch `ai`.
- [ ] **Step 5:** `execSync('npx tsx src/db/scripts/setup.ts', { env: { ...process.env, SETUP_ENV } })` — the existing setup pipeline (migrations + all seeds incl. demoSpec) runs against the fresh schemas.
- [ ] **Step 6:** Add `db:reset:dev` / `db:reset:qa` scripts.
- [ ] **Step 7:** Verify against **dev first**: `npm run db:reset:dev`, confirm prompt appears, abort works, full run leaves dev migrated + reseeded.

### Task 3: Spec types, spec files, env-config rewiring

**Files:** Create `src/db/seeds/demo/types.ts`, `qa-spec.ts`, `dev-spec.ts`; Modify `src/db/env-configs/types.ts`, `qa.ts`, `dev.ts`, `local.ts`

- [ ] **Step 1:** `types.ts`:
  - `DemoSpec` = `{ passwordHash?: string; languages?; organizations; users; projects }`.
  - `DemoUser` = `{ key, email, username, password?: string, passwordHash?: string, orgs: { org: string; roles: ('Org Member'|'Org Manager')[] }[], projectRoles: { project: string; role: 'Project Manager'|'Project Translator'|'Project Observer' }[], globalRoles?: ('SuperAdmin')[] }`.
  - `DemoProject` = `{ key, org, name, sourceLanguage, targetLanguage, sourceBible, pericopeSet?: string, milestones: DemoMilestone[] }`.
  - `DemoMilestone` = `{ key, name, type?: 'text'|'audio', connectivityProfile?: string, status?: 'not_started'|'in_progress'|'completed', books: DemoBook[] }`.
  - `DemoBook` = `{ code, chapters: [{ number, status, assignedTo?, peerChecker?, isAiEnabled? }] }`.
  - A `spread()` helper generates chapter lists from (count, statusWeights, userKeys) so specs stay compact.
- [ ] **Step 2:** `EnvConfig` gains `demoSpec?: DemoSpec` (import type from `seeds/demo/types` — watch for import cycles; if the db client import chain makes this circular, keep `DemoSpec` in `env-configs/types.ts` instead).
- [ ] **Step 3:** Widen `SeedUser.role` union to all six roles (kept for backward compat; the spec's `projectRoles`/`globalRoles` are the new path).
- [ ] **Step 4:** Write `qa-spec.ts` fully per the Demo Spec tables, with `QA_DEMO_PASSWORD_HASH` placeholder constant — filled by the user's Task 1 output.
- [ ] **Step 5:** Write `dev-spec.ts` factory `devSpec(credentials: { pmEmail, pmPassword?, seedPassword?, pmPasswordHash?, seedPasswordHash? })` producing the Dev/Local spec.
- [ ] **Step 6:** Rewire env-configs: `qa.ts` → `demoSpec: qaSpec`, drop `QA_PM_*` getters and `seedUsers`; `dev.ts` → `demoSpec: devSpec({...env vars})`, keep lazy validation pattern; `local.ts` → `demoSpec: devSpec({...hardcoded local creds})`. `EnvConfig.seedUsers` becomes optional/unused when `demoSpec` is present — update `setup.ts`'s user-seed step accordingly (Task 7).
- [ ] **Step 7:** `npm run typecheck` clean.

### Task 4: `seedDemoSpec` engine — reference rows (orgs, languages, bibles)

**Files:** Create `src/db/seeds/demo/index.ts`

- [ ] **Step 1:** Upsert spec languages by `langCodeIso6393`; upsert spec orgs by name (the env's `orgName` org already exists from `seedOrganizations` — the spec lists it too so orgs are self-contained; upsert makes that harmless).
- [ ] **Step 2:** Upsert spec bibles by `abbreviation`; link books via `bible_books` (dedupe-check existing links like `bibles.ts` does; resolve book codes → ids; `hasAudio` per spec).
- [ ] **Step 3:** Return a resolution context (`orgKey→id`, `userKey→id`, `projectKey→id`, `milestoneKey→id`, `bibleAbbrev→id`, `bookCode→id`) that Tasks 5–6's stages thread through — the engine should not re-query what it already resolved.
- [ ] **Step 4:** Standalone entry point (`process.argv[1]` guard) + `db:seed:demo:<env>` scripts for iteration (resolves env-config like `setup.ts`, runs only the demo stage).

### Task 5: `seedDemoSpec` engine — users + grants (the pattern fix)

**Files:** `src/db/seeds/demo/index.ts`; Modify `src/db/seeds/dev-users.ts`

- [ ] **Step 1:** Extend the `dev-users.ts` user writer (or extract a shared `upsertSeedUser` from it): accept `password` **or** `passwordHash` (hash written directly, no `hashPassword` call); keep authUser+authAccount+users creation and reconcile semantics unchanged.
- [ ] **Step 2:** Replace the old grant logic (org-scoped `PROJECT_MANAGER` for PM users) with the spec-driven grant writer:
  - `Org Member` + `Org Manager` → org-scoped rows (`orgId`, `projectId=NULL`).
  - Project roles → project-scoped rows (`orgId` = project's org, `projectId` set) — resolved **after** projects are created in Task 6's stage, so ordering is: orgs → users (anchors + org roles) → projects → milestones → book links → chapter assignments → project-scoped grants.
  - `SuperAdmin` → single global row (`orgId=NULL`, `projectId=NULL`); no anchor.
- [ ] **Step 3:** Reconcile cleanup — for seed-managed users, delete `user_roles` rows where a project-level role (PM/Translator/Observer) sits at org scope (`projectId IS NULL`): that scope is never correct for those roles and this repairs rows left by the old seed pattern. Never delete org-scoped `Org Member`/`Org Manager` or global rows, and never touch non-seed users' grants.
- [ ] **Step 4:** `createdBy` chain: `superadmin` (or first OM when no superadmin in spec) is the actor for all grants/user creation.

### Task 6: `seedDemoSpec` engine — projects, milestones, book links, assignments

- [ ] **Step 1:** Insert projects (idempotent by name+org) with language/org FK resolution; set `sourceBibleId` (from spec `sourceBible`), `pericopeSetId` (resolve spec `pericopeSet` name → `pericope_sets.id`), `createdBy` = org's OM (else superadmin), `status='active'`.
- [ ] **Step 2:** Insert milestones — `project_units` rows idempotent by `(projectId, name)` (no unique constraint exists; dedupe via lookup), writing `name`, `type` (default `'text'`), `status` (default `'in_progress'`), `connectivityProfile`. Register `milestoneKey→id` in the resolution context.
- [ ] **Step 3:** Insert `project_unit_bible_books` links (`projectUnitId`, `bibleId` = project's `sourceBibleId`, `bookId`); PK is `(project_unit_id, book_id)` — on conflict do nothing **unless** the existing row is soft-deleted, in which case set `deletedAt=NULL` (restore, mirroring `createMilestone`'s move-back semantics).
- [ ] **Step 4:** Insert `chapter_assignments` directly — do NOT call `chapterAssignmentsService.createChapterAssignmentForProjectUnit`: it discovers chapters from `bible_texts`, and the demo bibles have no texts until Follow-On 1, so it would produce zero rows. Generate rows for each spec chapter (`projectUnitId` = milestone id, `bibleId`, `bookId`, `chapterNumber`, `status`, `assignedUserId`, `peerCheckerId`, `isAiEnabled`). Insert one `chapter_assignment_status_history` row per assignment (the seeded status) so history views aren't empty — mirroring the service's initial-history write. Respect `uq_chapter_assignment_per_chapter`; on reconcile, update status/assignee/peerChecker/isAiEnabled rather than skip.
- [ ] **Step 5:** Then apply Task 5's project-scoped grants (projectIds now resolvable).

### Task 7: Wire into setup + scripts

**Files:** Modify `src/db/scripts/setup.ts`, `package.json`

- [ ] **Step 1:** Replace the `seedDevUsers(config.seedUsers, config.orgName)` call at step 5 with `seedDemoSpec` when `config.demoSpec` is present (all three envs now provide one); keep the old call path only if a config lacks `demoSpec` — or remove `seedUsers` entirely and always require `demoSpec`. Prefer removal: one code path.
- [ ] **Step 2:** Add `db:seed:demo:dev` / `db:seed:demo:qa` standalone scripts.
- [ ] **Step 3:** `npm run typecheck && npm run lint` clean.

### Task 8: Docs

- [ ] **Step 1:** Update `docs/db-provisioning-and-setup.md` — add `db:reset:*` to the command table + a "Resetting a QA/Dev environment" section (confirm gate, what gets dropped, what survives — the `ai` schema).
- [ ] **Step 2:** Update the env-var table: remove `QA_PM_EMAIL`/`QA_PM_PASSWORD`, note the committed-hash model.

## Follow-Ons (tracked, not built here)

1. **BSB/WEB verse text** — user supplies data; add `src/db/seeds/demo/data/bible-texts.json` + a small loader (`db:seed:demo-texts`) writing `bible_texts` rows for the demo bibles/books. Until then source panels for Mark/John/Ruth/Jonah/James render empty (dev's IRV project is unaffected — its texts are already seeded).
2. **Audio for the OBT project** — set `bibles.externalId` (and the DBL audio bible id if needed) on WEB once the user supplies DBL ids; verify `DBL_*` env creds exist in the QA App Service config. No code changes needed — `bible-audio.service` resolves at runtime. (The `chichewa-obt` milestone already carries `type='audio'`; this follow-on only wires real audio files.)
3. **AI-suggestions corpus** — separate spec/strategy for where `gjk` `translated_verses` seed content lives (must not become a large committed blob). Until then AI suggestions return empty in QA.
4. **Remove the `project:create` TEMP bypass** in `projects.route.ts` — explicitly marked for removal once QA has real org-manager accounts, which this plan delivers. Separate change with its own testing; flag it to whoever picks up the org-manager work (`feat/org-manager-self-service` / `feat/organization-onboarding` are in flight).

## Verification

- `npm run db:reset:qa` end-to-end: prompt → drop → migrate → seed → demo spec, no manual steps.
- Login smoke test (web + mobile): one account per row in the user table; `cwhite@gloo.us` sees all orgs (global), `hi-pm` sees the org switcher with 2 orgs, `nh-om` sees the empty first-run state.
- **Grant-scope SQL check** (the point of this expansion): zero rows where a project-level role (PM/Translator/Observer) has `project_id IS NULL`; every non-superadmin seed user has an `Org Member` anchor per org; OM grants are org-scoped; the SuperAdmin's only row is `(org_id NULL, project_id NULL)`. Applies on both `qa` (demo spec) and `dev` (dev spec) after `db:setup:<env>`.
- **Milestone shape check**: `projects.source_bible_id`/`pericope_set_id` set on all 3 QA projects; `project_units` rows carry the spec names + types (`Old Testament Narratives` is `audio`); book links have `deleted_at IS NULL`; no book is actively linked to two milestones in one project.
- `chapter_assignments` status counts match the distribution tables per book; `peerCheckerId` pairing on mob chapters; each seeded assignment has at least one `chapter_assignment_status_history` row.
- `npm run db:setup:qa` and `db:setup:dev` re-runs are clean (idempotent reconcile, no dupes, no org-scoped PM rows recreated, soft-deleted book links restored rather than duplicated).
