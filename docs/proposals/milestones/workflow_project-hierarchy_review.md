# Review: Project → Milestone Hierarchy Workflow

A response to [`workflow_project-hierarchy.md`](./workflow_project-hierarchy.md), with every claim checked against `fluent-api/src` as of 2026-09-03.

**Verdict:** the shape is right. Re-parenting `project_units` rather than restructuring them is the correct call, and standing up a separate `milestones` domain instead of overloading `projects.service.ts` is the right separation. What follows are five blocking defects, nine significant gaps, and a recommendation on each open question.

---

## 1. Blocking Problems

These must be resolved before the migration script or the schema change is written.

### 1.1 `ON CONFLICT DO NOTHING` on an `UPDATE` is not valid Postgres

**Where:** §2 Execution Steps, step 8; §2 Migration Edge Cases, "Duplicate `user_roles` after merging".

Postgres has no `ON CONFLICT` clause for `UPDATE` — it exists only on `INSERT`. The plan's de-duplication strategy cannot be written as specified.

This matters because `user_roles` carries a real uniqueness constraint (`src/db/schema.ts:862`):

```sql
uq_user_role_grant ON (user_id, COALESCE(org_id, -1), COALESCE(project_id, -1), role_id)
```

So `UPDATE user_roles SET project_id = <master> WHERE project_id IN (<merged>)` will hard-fail the moment any user already holds the same role on the master project — which is precisely the common case, since the same PM typically created several of the projects being merged.

**Fix — one of:**

Deduplicate across the **whole merge group** (master included) on the full uniqueness key, then update the survivors. It is not enough to delete only the grants that collide with an existing master grant: if two _non-master_ projects in the group each carry `(user U, role R)` and the master carries neither, nothing is deleted, and the subsequent `UPDATE` drives both rows to the same `(U, org, master, R)` key inside a single statement — which the unique index rejects.

```sql
-- Keep exactly one grant per (user, org, role) across the merge group,
-- preferring a grant that already sits on the master project.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, COALESCE(org_id, -1), role_id
           ORDER BY (project_id = :master_id) DESC, id
         ) AS rn
  FROM user_roles
  WHERE project_id = ANY(:group_ids)   -- master + all merged projects
)
DELETE FROM user_roles WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

UPDATE user_roles SET project_id = :master_id WHERE project_id = ANY(:group_ids);
```

The `INSERT ... SELECT ... ON CONFLICT DO NOTHING`-into-master-then-delete variant works too, but only if the `SELECT` is itself `DISTINCT` on the uniqueness key. A bare `ON CONFLICT DO NOTHING` (no conflict target) is the right form; an explicit target would have to restate the `COALESCE` expressions.

**Test to add:** a migration fixture with two non-master projects granting the same user the same role, with no corresponding master grant.

### 1.2 Step 9 can silently destroy role grants

**Where:** §2 Execution Steps, step 9 ("Delete orphaned project records").

`user_roles.project_id` is declared `ON DELETE CASCADE` (`src/db/schema.ts:852`). If step 8 partially succeeds — or if steps are reordered, or the migration is re-run after a failure — step 9 does not error on leftover grants. It deletes them.

**Fix:** before deleting any project, assert both `COUNT(project_units WHERE project_id = X) = 0` **and** `COUNT(user_roles WHERE project_id = X) = 0`, and abort the migration on violation. Run the mutating steps inside a single transaction so a partial merge cannot be left on disk — see §4.3 for how that squares with the admin sign-off, which cannot sit inside an open transaction.

### 1.3 "Change to LEFT JOIN" badly understates the blast radius

**Where:** §6 Risks, "`baseJoinQuery` uses INNER JOINs" — impact given as "Projects with zero milestones disappear from the API."

The real impact is larger. `baseJoinQuery` (`src/domains/projects/projects.query-builder.ts:64`) backs `getById` (`projects.repository.ts:165`), and `getById` is what `requireProjectAccess` calls to load and authorize the project (`project-auth.middleware.ts:35`). A project with zero milestones therefore returns `PROJECT_NOT_FOUND` from **every** project-scoped route — including `PATCH /projects/:id`, `GET /projects/:id/users`, and the new `POST /projects/:projectId/milestones`.

A freshly created project would be immediately unusable: you could not add the first milestone to it.

**Fix, and it is better than a LEFT JOIN:** once `projects.source_bible_id` exists, delete the entire `project_units → project_unit_bible_books → sourceBibles` join chain from `baseJoinQuery` and join `bibles` directly on `projects.source_bible_id`. The chain exists today only to resolve the source Bible name; the new column makes it redundant.

This also disposes of a scaling problem the plan does not mention: `baseJoinQuery` uses `selectDistinct` with a `groupBy` to paper over the row multiplication those joins cause. Today that is 1 unit × N books. Post-consolidation it becomes M milestones × N books per project, on every project list request.

### 1.4 `PATCH /projects/:id` is not "keep as-is"

**Where:** §4 "What Happens to Existing `/projects` Routes" — listed as **Keep as-is**.

`updateProject` accepts a `projectUnitStatus` field and forwards it to `updateProjectUnitStatusByProjectId` (`projects.repository.ts:222`):

```ts
await tx.update(project_units).set({ status }).where(eq(project_units.projectId, projectId));
```

The `WHERE` is scoped to the project, not to a unit. Today that is harmless — there is exactly one unit. After consolidation, a single project PATCH silently overwrites the status of every milestone under it.

**Fix:** remove `projectUnitStatus` from the project update input and move milestone status to `PATCH /projects/:projectId/milestones/:milestoneId` (a route the plan does not currently include — see §2.5).

### 1.5 `DELETE /projects/:id` becomes a mass-destruction endpoint

**Where:** §4 "What Happens to Existing `/projects` Routes" — listed as **Keep as-is. Cascade already deletes child `project_units`.**

That sentence is accurate and that is precisely the problem. The cascade chain is:

```text
projects
  └─ project_units            ON DELETE CASCADE  (schema.ts:313)
       ├─ chapter_assignments ON DELETE CASCADE  (schema.ts:635)
       ├─ translated_verses   ON DELETE CASCADE  (schema.ts:502)
       └─ project_unit_bible_books ON DELETE CASCADE
```

`repo.remove` issues a bare `DELETE FROM projects WHERE id = ?` (`projects.repository.ts:230-236`). Today one project owns one unit, so a delete destroys one book scope's work. After consolidation, a single call destroys **every milestone under the merged project and all of its translated verses** — including work belonging to teams whose projects were merged in by the migration, not by their own choice.

This is the most severe consequence of consolidation and the proposal treats it as a no-op.

**Fix:** reject `DELETE /projects/:id` when the project still has milestones (`409` with a count), and require milestones to be deleted individually first. If a cascading project delete is genuinely wanted later, it needs an explicit confirmation parameter, an audit entry, and tests that assert the blast radius.

---

## 2. Significant Gaps

### 2.1 Consolidation can merge projects that translated the same book

**Where:** §2 Consolidation Criteria.

The grouping key is `organization` + `sourceLanguage` + `targetLanguage` + `bibleId` + `pericopeSetId`. **Book scope is not part of it.** Two projects that both drafted Genesis into the same target language will be merged into one project holding two milestones, each with:

- its own `chapter_assignments` rows — unaffected by re-parenting, since `uq_chapter_assignment_per_chapter` is keyed on `project_unit_id` (`schema.ts:656`), and
- its own `translated_verses` rows — keyed `(project_unit_id, bible_text_id)` (`translated-verses.repository.ts:118`).

Nothing breaks technically. But the product now presents a single project containing two divergent, independently-edited translations of the same verses in the same language, with no reconciliation path and no UI that acknowledges the overlap.

**This belongs in §7 as the first open question, ahead of naming.** Options: add book-scope disjointness to the grouping key (fewer merges, no overlap); merge anyway and surface the overlap in the Milestones table; or merge anyway and accept it as a data-cleanup task for admins.

### 2.2 `GET /projects/:projectId/chapter-assignments` is unaddressed

The chapter-assignment query filters on `project_units.projectId` (`chapter-assignments.repository.ts:502`), so post-merge it returns the chapters of _every_ milestone in one undifferentiated list. §5 mentions the frontend's `chapterAssignments[0].projectUnitId` assumption but not the endpoint feeding it.

**Fix:** add an optional `milestoneId` (i.e. `projectUnitId`) filter to that route, and have the Milestone Detail page pass it. The unfiltered form remains useful for the Project Detail aggregate.

### 2.3 USFM export will still be named after the project

§5 renames the frontend button "Export Project" → "Export Milestone". But `usfm.repository.ts:20` `getProjectName(projectUnitId)` resolves `projects.name` through the unit and that value flows into the exported document. After the change it must read the new `project_units.name`, with a fallback to the project name for any milestone left unnamed.

### 2.4 Two `projects` columns are missing from §3a

| Column           | Why it matters                                                                                                                                                                                                    |
| :--------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`         | `projectAssignmentStatusEnum`, defaults `not_assigned` (`schema.ts:198`). What is the status of a project with zero milestones? `recordProjectAssignmentActivity` still flips it on first assignment, but say so. |
| `lastActivityAt` | `schema.ts:215`, maintained by `touchProjectActivity` via the unit → project lookup. Survives re-parenting, but the aggregate semantics across milestones should be stated.                                       |

### 2.5 The milestones API is missing `PATCH`

§4 defines GET (list), POST, GET (one), and DELETE. There is no update route — yet the plan requires milestone rename, status change (displaced from §1.4), and connectivity-profile override. Add `PATCH /projects/:projectId/milestones/:milestoneId`.

Relatedly, §4 does not say how the new routes are authorized. They should reuse `requireProjectAccess` on `:projectId` plus a check that the milestone actually belongs to that project — otherwise `/projects/1/milestones/999` authorizes against project 1 while operating on a milestone of project 2.

### 2.6 Nothing enforces the milestone/project Bible invariant

§3c says `project_unit_bible_books.bible_id` "inherits from parent Project's `source_bible_id` at creation." Nothing enforces it — no FK, no check constraint, no service-layer validation. That invariant is exactly what makes the `baseJoinQuery` simplification in §1.3 safe, so it should be enforced in `milestones.service.ts` at creation and ideally asserted post-migration.

### 2.7 Consolidation silently rewrites `connectivityProfile`

`connectivityProfile` is a project-level value today: the web client folds it into `projects.metadata` at create time (`fluent-web/src/features/projects/components/index.tsx:70`, via `buildProjectMetadata`). It is **not** in the consolidation grouping key (§2), and no migration step copies it down to the new `project_units.connectivity_profile`.

So merging two projects with different profiles leaves every non-master milestone silently inheriting the master's profile — a behavioral change to already-running translation work, invisible in the migration output.

**Fix — either:** add `metadata->>'connectivityProfile'` to the grouping key (fewer merges, no drift), **or** backfill `project_units.connectivity_profile` from each source project's metadata _before_ re-parenting, so the override carries the original value. The second is preferable: it is exactly what the new override column is for, and it keeps the consolidation aggressive.

Note this only works under Option A (§4.1); under Option B the same value has to be written into a JSONB blob.

### 2.8 "Overall progress" is undefined, and overlap makes it ambiguous

§4 adds "aggregated progress" to `GET /projects` and "aggregate chapter status counts across all milestones" to `GET /projects/:id`, without specifying the contract. Two different reasonable readings disagree:

- **Sum of chapters across milestones.** Double-counts when two milestones cover the same book — which §2.1 says consolidation will actively produce. A project showing "120 of 200 chapters" where 40 of them are the same 40 chapters twice is simply wrong.
- **Unweighted mean of per-milestone percentages.** No double-counting, but a one-book milestone at 100% offsets a 30-book milestone at 10%.

**Fix:** specify the denominator and the status-rollup rule before building either the API or the table that renders it. Given §2.1, my recommendation is chapter-sum with a documented statement that overlapping chapters are counted once per milestone, plus a visible overlap indicator on the Milestones table — or resolve §2.1 so overlap cannot occur, which makes the sum unambiguous.

### 2.9 The skip-and-warn edge case contradicts the rollout gate

§2 Migration Edge Cases says a project with no `project_unit_bible_books` rows is skipped with a warning. But `source_bible_id` is derived _from_ those rows (step 2), so a skipped project ends with `source_bible_id IS NULL` — and §5 phase 1 gates the rollout on 100% non-null coverage. As written the migration can complete "successfully" while making that gate unachievable.

**Fix:** treat a project with no book rows as a migration failure with a named repair path (assign a source Bible manually, or delete the empty project), not a warning. If such projects are expected to exist in production, they should be inventoried and cleaned up in phase 0, before any of this runs.

---

## 3. Smaller Notes

- **`POST /projects` role grant.** The route grants the creator a PM role and, on failure, compensates by deleting the project it just made (`projects.route.ts:239-246`). Since §4 already opens this handler up to simplify it, fold the grant into the same transaction rather than leaving the compensating delete in place.
- **`GET /projects/:id/books` loses milestone attribution.** It `selectDistinct`s on book id (`books/project-books.repository.ts`), so the response never duplicates — the plan is right that it "just works" as a flat book list. But the book-details metadata dialog needs to know _which_ milestone owns a book to hit `/project-units/:id/book-details`, and because §2.1 permits overlapping scopes a book can have **several** owners. Attaching a single `projectUnitId` to a distinct book row would pick an arbitrary one and silently edit the wrong milestone's metadata. Either return one row per (milestone, book) — dropping the `selectDistinct` — or carry every owning `projectUnitId` on the row, or source the list from the milestone endpoint instead.
- **No project-level export after this change.** Parity holds — each old project becomes one milestone, so every existing export still has an equivalent — but §5 should state that a project spanning five milestones has no single-file export, in case that is a surprise.

---

## 4. Recommendations on the Open Questions

### 4.1 `project_units` schema: Option A or B?

**Take Option A (strict columns).**

`type` and `connectivity_profile` are closed enumerations you will filter, group, and badge on. The `projects.metadata` JSONB precedent is not an argument for repeating the pattern — it is where `connectivityProfile` ended up, not where it belonged. Add a column when a setting is genuinely open-ended; `text | audio` is not.

Concretely: `name varchar(255) NOT NULL`, `type varchar` (or a pgEnum, matching the `projectStatusEnum` precedent already in the file) `NOT NULL DEFAULT 'text'`, `connectivity_profile varchar NULL` where NULL means inherit.

### 4.2 Consolidated project naming

**Option C, with A as the default.** Auto-generating from the language pair (B) produces collisions the moment an org has two English → Spanish efforts, which is exactly the situation consolidation creates. Seed the master with the oldest project's name, and make rename a first-class admin action so the result can be corrected. Note that milestones keep the original per-project names either way, so nothing is lost.

### 4.3 Merging user roles and access expansion

As written this is a **privilege escalation performed by a migration**, not a preference. Whether or not milestone-level role scoping is in scope (and it reasonably is not for v1), the migration must be accountable.

The widening happens at **step 8** — the moment grants are re-pointed at the master — not at step 9. So the approval has to gate step 8, which means the migration must run in two phases. (This also resolves a tension with §1.2, where I asked for steps 1–9 in one transaction: you cannot hold a transaction open across a human sign-off.)

**Phase A — dry run, no writes.** Compute the merge groups, elect masters, and emit the full plan: every `(user, role, old_project → master_project)` move, and, called out separately, every user whose effective access widens as a result. Write nothing.

**Phase B — execute, after sign-off.** Run steps 5–9 in a single transaction against the _same_ plan Phase A produced, aborting if the underlying data changed in between (compare a checksum of the group membership). Steps 8 and 9 are then atomic with respect to each other, so the cascade hazard in §1.2 cannot open a window.

Keep the pre-merge `user_roles` contents as a backup table for the length of the rollback window. That converts an invisible change into a reviewed one without requiring the larger scoping work.

---

## 5. Suggested Order of Work

| Phase | Work                                                                                                                                                                                                      | Gate                                                              |
| :---- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------- |
| 0     | Decide §4.1, §4.2, §4.3, the book-overlap question (§2.1), the progress contract (§2.8), and the connectivity-profile question (§2.7). Inventory projects with no `project_unit_bible_books` rows (§2.9). | All six answered; empty-scope projects repaired or deleted.       |
| 1     | Schema: add `projects.source_bible_id`, `project_units.{name,type,connectivity_profile}`. Backfill `source_bible_id`, `name`, and `connectivity_profile`.                                                 | 100% non-null `source_bible_id`; verified in prod before phase 2. |
| 2     | Rework `baseJoinQuery` per §1.3; remove `projectUnitStatus` from `PATCH /projects/:id` per §1.4; guard `DELETE /projects/:id` per §1.5; fix `getProjectName` per §2.3.                                    | Existing project tests green with zero-milestone fixtures added.  |
| 3     | New `milestones` domain (incl. the PATCH route and auth from §2.5).                                                                                                                                       | Milestone CRUD covered by tests.                                  |
| 4     | Simplify `POST /projects`; coordinate the client contract change with mobile and web.                                                                                                                     | Synchronized release agreed.                                      |
| 5a    | Consolidation **dry run** (§4.3 Phase A): merge plan + access-widening report, no writes.                                                                                                                 | Admin sign-off on the report.                                     |
| 5b    | Consolidation **execute** (§4.3 Phase B): steps 5–9 in one transaction, per §1.1 and §1.2.                                                                                                                | Plan checksum matches; post-migration invariants asserted.        |
| 6     | Frontend: Project Detail hub, Milestone Detail, dialogs.                                                                                                                                                  | —                                                                 |

The key property of this ordering is that phases 1–4 are individually shippable and reversible, and none of them require the consolidation migration to have run. The irreversible step (5b) happens last, behind a reviewed dry run, against a codebase that already handles both one-milestone and many-milestone projects correctly — and, critically, one where `DELETE /projects/:id` can no longer take out milestones the deleter never created (§1.5).
