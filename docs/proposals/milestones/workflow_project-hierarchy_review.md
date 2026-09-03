# Review: Project → Milestone Hierarchy Workflow

A response to [`workflow_project-hierarchy.md`](./workflow_project-hierarchy.md), with every claim checked against `fluent-api/src` as of 2026-09-03.

**Verdict:** the shape is right. Re-parenting `project_units` rather than restructuring them is the correct call, and standing up a separate `milestones` domain instead of overloading `projects.service.ts` is the right separation. What follows are four blocking defects, five significant gaps, and a recommendation on each open question.

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

- Delete the rows that would collide, then update the survivors:
  ```sql
  DELETE FROM user_roles ur
  WHERE ur.project_id = ANY(:merged_ids)
    AND EXISTS (
      SELECT 1 FROM user_roles m
      WHERE m.user_id = ur.user_id
        AND m.role_id = ur.role_id
        AND m.project_id = :master_id
    );
  UPDATE user_roles SET project_id = :master_id WHERE project_id = ANY(:merged_ids);
  ```
- Or `INSERT ... SELECT ... ON CONFLICT DO NOTHING` into the master, then delete the originals. Note that a bare `ON CONFLICT DO NOTHING` (no conflict target) works here; an explicit target would have to restate the `COALESCE` expressions.

### 1.2 Step 9 can silently destroy role grants

**Where:** §2 Execution Steps, step 9 ("Delete orphaned project records").

`user_roles.project_id` is declared `ON DELETE CASCADE` (`src/db/schema.ts:852`). If step 8 partially succeeds — or if steps are reordered, or the migration is re-run after a failure — step 9 does not error on leftover grants. It deletes them.

**Fix:** before deleting any project, assert both `COUNT(project_units WHERE project_id = X) = 0` **and** `COUNT(user_roles WHERE project_id = X) = 0`, and abort the migration on violation. Run steps 1–9 inside a single transaction so a partial merge cannot be left on disk.

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

---

## 3. Smaller Notes

- **`POST /projects` role grant.** The route grants the creator a PM role and, on failure, compensates by deleting the project it just made (`projects.route.ts:239-246`). Since §4 already opens this handler up to simplify it, fold the grant into the same transaction rather than leaving the compensating delete in place.
- **`GET /projects/:id/books` loses milestone attribution.** It `selectDistinct`s on book id (`books/project-books.repository.ts`), so duplicates across milestones collapse cleanly — the plan is right that it "just works." But the book-details metadata dialog needs to know _which_ milestone owns a book to hit `/project-units/:id/book-details`. Either add `projectUnitId` to the response or source that list from the milestone endpoint.
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

As written this is a **privilege escalation performed by a migration**, not a preference. Whether or not milestone-level role scoping is in scope (and it reasonably is not for v1), the migration must be accountable:

1. Emit a report of every `(user, role, old_project → master_project)` move, and specifically every user whose effective access widened.
2. Get that report signed off by an admin _before_ the cleanup step runs.
3. Keep the pre-merge grant table as a backup for the length of the rollback window.

That converts an invisible change into a reviewed one without requiring the larger scoping work.

---

## 5. Suggested Order of Work

| Phase | Work                                                                                                                             | Gate                                                              |
| :---- | :------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------- |
| 0     | Decide §4.1, §4.2, §4.3 and the book-overlap question (§2.1).                                                                    | All four answered.                                                |
| 1     | Schema: add `projects.source_bible_id`, `project_units.{name,type,connectivity_profile}`. Backfill `source_bible_id` and `name`. | 100% non-null `source_bible_id`; verified in prod before phase 2. |
| 2     | Rework `baseJoinQuery` per §1.3; remove `projectUnitStatus` from `PATCH /projects/:id` per §1.4; fix `getProjectName` per §2.3.  | Existing project tests green with zero-milestone fixtures added.  |
| 3     | New `milestones` domain (incl. the PATCH route and auth from §2.5).                                                              | Milestone CRUD covered by tests.                                  |
| 4     | Simplify `POST /projects`; coordinate the client contract change with mobile and web.                                            | Synchronized release agreed.                                      |
| 5     | Consolidation migration (§1.1, §1.2), single transaction, with the §4.3 access report.                                           | Admin sign-off on the report.                                     |
| 6     | Frontend: Project Detail hub, Milestone Detail, dialogs.                                                                         | —                                                                 |

The key property of this ordering is that phases 1–4 are individually shippable and reversible, and none of them require the consolidation migration to have run. The irreversible step (5) happens last, against a codebase that already handles both one-milestone and many-milestone projects correctly.
