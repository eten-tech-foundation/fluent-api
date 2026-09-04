# Project → Milestone Hierarchy Workflow

This document covers the complete workflow for transitioning to a two-level hierarchy: a **Project** (language-scope container) with zero or more **Milestones** underneath.

---

## 1. Current State Analysis

### Current Database Tables

| Table                      | Purpose                                                  | Key Fields                                                                                                           |
| :------------------------- | :------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| `projects`                 | The main entity users see as a "Project"                 | `name`, `sourceLanguage`, `targetLanguage`, `organization`, `metadata` (stores connectivityProfile), `pericopeSetId` |
| `project_units`            | Always exactly 1 per project today; holds the book scope | `projectId`, `status`                                                                                                |
| `project_unit_bible_books` | Links a project unit to its assigned books               | `projectUnitId`, `bibleId`, `bookId`, plus USFM metadata fields                                                      |
| `user_roles`               | Grants users access at org or project level              | `userId`, `orgId`, `projectId`, `roleId`                                                                             |
| `chapter_assignments`      | Tracks per-chapter drafting/review status                | `projectUnitId`, `bibleId`, `bookId`, `chapterNumber`, `status`                                                      |

### Current Create Project Flow

When a user creates a "Project" today, the backend does all of this **in one transaction**:

1. Inserts a row into `projects`.
2. Inserts exactly **one** row into `project_units` linked to that project.
3. Inserts rows into `project_unit_bible_books` for each selected book.
4. Creates `chapter_assignments` for every chapter in every selected book.
5. Enqueues a background job to fetch source text from DBL.
6. Grants the creator a Project Manager role on the new project.

### Current API Routes

| Route                                        | Verb                  | Purpose                                             |
| :------------------------------------------- | :-------------------- | :-------------------------------------------------- |
| `/projects`                                  | GET                   | List all projects for the user                      |
| `/projects`                                  | POST                  | Create a new project (+ unit + books + assignments) |
| `/projects/:id`                              | GET                   | Get a single project's details                      |
| `/projects/:id`                              | PATCH                 | Update a project                                    |
| `/projects/:id`                              | DELETE                | Delete a project                                    |
| `/projects/:projectId/books`                 | GET                   | Get books for a project                             |
| `/projects/:projectId/users`                 | GET/POST/DELETE/PATCH | Manage project team                                 |
| `/projects/:projectId/chapter-assignments`   | GET/PATCH             | Manage chapter assignments                          |
| `/project-units/:projectUnitId/usfm`         | POST                  | Export USFM                                         |
| `/project-units/:projectUnitId/book-details` | GET/PATCH             | Book-level USFM metadata                            |

### Current Frontend Routing

| URL                    | What It Shows                                                                        |
| :--------------------- | :----------------------------------------------------------------------------------- |
| `/projects`            | List of all projects (`ProjectsPage`)                                                |
| `/projects/:projectId` | Detail page with chapters, assignments, progress, team, export (`ProjectDetailPage`) |

### Critical Coupling: `projectUnitId`

The `projectUnitId` is deeply embedded throughout the system:

- Fetching translated verses (`/translated-verses?projectUnitId=X`)
- Fetching/saving AI suggestions
- USFM export (`/project-units/:id/usfm`)
- Repeated-words checks (sent as `project_id` to the Greek Room service)
- Chapter assignment queries
- The `ProjectItem` object passed to the translation editor

The `project_units` table and its IDs **cannot be removed or restructured**. They must remain stable.

---

## 2. Data Migration Strategy (Consolidation)

Instead of a 1:1 conversion, we consolidate projects that share the same configuration into a single overarching Project.

### Consolidation Criteria

Existing projects are grouped if they share the exact same combination of:

- `organization`
- `sourceLanguage`
- `targetLanguage`
- `bibleId` (derived from `project_unit_bible_books`)
- `pericopeSetId`

### Execution Steps

| Step | Action                         | Details                                                                                                              |
| :--- | :----------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| 1    | **Add new columns**            | Run schema migration: add `source_bible_id` to `projects`, add `name` + `type` (or `metadata`) to `project_units`.   |
| 2    | **Backfill `source_bible_id`** | For each project, read the `bibleId` from its `project_unit_bible_books` and write it to `projects.source_bible_id`. |
| 3    | **Backfill milestone names**   | Copy each old `projects.name` into its `project_units.name`.                                                         |
| 4    | **Backfill milestone type**    | Set all existing milestones to `text` (since audio doesn't exist yet).                                               |
| 5    | **Group projects**             | Identify groups matching the consolidation criteria.                                                                 |
| 6    | **Elect master project**       | Designate the oldest project (by `createdAt`) as the Master.                                                         |
| 7    | **Re-parent milestones**       | Update `project_units.projectId` for non-master projects to point to the Master.                                     |
| 8    | **Merge user roles**           | Move `user_roles` rows to the Master. De-duplicate with `ON CONFLICT DO NOTHING`.                                    |
| 9    | **Cleanup**                    | Delete orphaned project records.                                                                                     |

### Migration Edge Cases

| Edge Case                            | How We Handle It                       |
| :----------------------------------- | :------------------------------------- |
| `pericopeSetId` is NULL (legacy)     | Treat NULL as its own group value.     |
| No `project_unit_bible_books` rows   | Skip and log a warning.                |
| Duplicate `user_roles` after merging | `ON CONFLICT DO NOTHING`.              |
| Solo projects (group of 1)           | Just backfill new columns, no merging. |

---

## 3. Database Structure & Changes

### 3a. `projects` Table (The Top-Level Project)

| Field             | Current Status | Action         | Notes                                                                                   |
| :---------------- | :------------- | :------------- | :-------------------------------------------------------------------------------------- |
| `name`            | Exists         | Keep           | Becomes the overarching Project name.                                                   |
| `source_language` | Exists         | Keep           | Fixed at project creation.                                                              |
| `target_language` | Exists         | Keep           | Fixed at project creation.                                                              |
| `pericope_set_id` | Exists         | Keep           | Fixed at project creation.                                                              |
| `metadata`        | Exists         | Keep           | Already stores `connectivityProfile` (the project default).                             |
| `source_bible_id` | **Missing**    | **ADD COLUMN** | New integer FK to `bibles`. Needed because projects can now exist with zero milestones. |

### 3b. `project_units` Table (The Milestones)

This table needs a milestone name, a type indicator (text vs audio), and optionally a per-milestone connectivity profile override. We can do this in one of two ways:

#### Option A: Strict Columns

| Field                  | Current Status | Action         | Notes                                                                          |
| :--------------------- | :------------- | :------------- | :----------------------------------------------------------------------------- |
| `project_id`           | Exists         | Keep           | Links milestone to its parent Project.                                         |
| `status`               | Exists         | Keep           | Not Started / In Progress / Completed.                                         |
| `name`                 | **Missing**    | **ADD COLUMN** | `varchar` — the milestone's display name.                                      |
| `type`                 | **Missing**    | **ADD COLUMN** | `varchar` or `enum` — e.g. `text`, `audio`. Defaults to `text`.                |
| `connectivity_profile` | **Missing**    | **ADD COLUMN** | `varchar` — overrides the project's default. NULL means "use project default". |

#### OR Option B: Name Column + Metadata JSONB

| Field        | Current Status | Action         | Notes                                                                                                                                                 |
| :----------- | :------------- | :------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id` | Exists         | Keep           | Links milestone to its parent Project.                                                                                                                |
| `status`     | Exists         | Keep           | Not Started / In Progress / Completed.                                                                                                                |
| `name`       | **Missing**    | **ADD COLUMN** | `varchar` — the milestone's display name.                                                                                                             |
| `metadata`   | **Missing**    | **ADD COLUMN** | JSONB — stores `type` and `connectivityProfile` and any future milestone-specific settings. Mirrors the pattern already used in the `projects` table. |

### 3c. `project_unit_bible_books` Table (Milestone Scope)

| Field             | Current Status | Action | Notes                                                                                              |
| :---------------- | :------------- | :----- | :------------------------------------------------------------------------------------------------- |
| `project_unit_id` | Exists         | Keep   | Links to the milestone.                                                                            |
| `bible_id`        | Exists         | Keep   | Remains for backwards compatibility. Inherits from parent Project's `source_bible_id` at creation. |
| `book_id`         | Exists         | Keep   | The specific book in this milestone's scope.                                                       |
| USFM fields       | Exist          | Keep   | `runningHeader`, `bookTitle`, TOC fields — untouched.                                              |

---

## 4. API Strategy

### Approach: New Milestones Domain (Clean Separation)

Rather than modifying the existing `/projects` routes to handle both project-level and milestone-level operations, we introduce a **new `milestones` domain** with its own routes, service, repository, and types. This keeps the codebase scalable and avoids tangling two different concerns into one route file.

### New Domain: `src/domains/milestones/`

| Route                                          | Verb       | Purpose                                                                                                                                                                                   |
| :--------------------------------------------- | :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/projects/:projectId/milestones`              | **GET**    | List all milestones for a project (name, book scope, progress, status badge).                                                                                                             |
| `/projects/:projectId/milestones`              | **POST**   | Create a new milestone. Receives: name, selected books, type, connectivity profile. Creates `project_units` + `project_unit_bible_books` + `chapter_assignments`. Triggers DBL ingestion. |
| `/projects/:projectId/milestones/:milestoneId` | **GET**    | Get a single milestone's details (chapters, assignments, progress).                                                                                                                       |
| `/projects/:projectId/milestones/:milestoneId` | **DELETE** | Delete a milestone (cascades to assignments and translations).                                                                                                                            |

**Domain structure:**

```text
src/domains/milestones/
├── milestones.route.ts
├── milestones.service.ts
├── milestones.repository.ts
└── milestones.types.ts
```

### What Happens to Existing `/projects` Routes

| Route                             | Change                                                                                                                                                                                       |
| :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /projects`                   | **Modify query only.** Change `INNER JOIN` to `LEFT JOIN` on `project_units`. Add milestone count and aggregated progress to the response.                                                   |
| `POST /projects`                  | **Simplify.** Remove the `project_units`, `project_unit_bible_books`, and `chapter_assignments` creation logic. Only insert into `projects` table. Keep the PM role grant.                   |
| `GET /projects/:id`               | **Modify response.** Aggregate chapter status counts across all milestones. Add milestone count to response.                                                                                 |
| `PATCH /projects/:id`             | **Keep as-is.** Still updates project-level fields.                                                                                                                                          |
| `DELETE /projects/:id`            | **Keep as-is.** Cascade already deletes child `project_units`.                                                                                                                               |
| `GET /projects/:id/books`         | **Keep as-is.** This query already walks `project_units` → `project_unit_bible_books` by `projectId`, so it naturally returns books from ALL milestones. Useful for the Project Detail view. |
| `GET /projects/:id/users`         | **Keep as-is.** User roles are scoped to `projectId`, not milestone.                                                                                                                         |
| `/project-units/:id/usfm`         | **Keep as-is.** Already scoped to a specific `projectUnitId` (milestone).                                                                                                                    |
| `/project-units/:id/book-details` | **Keep as-is.** Already scoped to a specific `projectUnitId` (milestone).                                                                                                                    |

### Why This Is Better Than Modifying Existing Routes

| Concern                | Modifying Existing Routes                                                                        | New Milestones Domain                                                                              |
| :--------------------- | :----------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------- |
| **Code clarity**       | The `projects.service.ts` becomes a 500+ line file mixing project and milestone logic            | Each domain has a single, focused responsibility                                                   |
| **Testing**            | Existing project tests must all be rewritten to account for milestone logic                      | Milestone tests are isolated; existing project tests need minimal changes                          |
| **Future scalability** | Adding milestone-level features (delete, edit, reorder) requires touching the core projects code | Milestone features are self-contained in their own domain                                          |
| **API contract**       | The `POST /projects` response and input schema change drastically, breaking mobile clients       | `POST /projects` input simplifies (fewer fields), but existing fields don't change type or meaning |

---

## 5. Frontend Impact

### New Pages

| Page                      | URL                               | Description                                                                                                           |
| :------------------------ | :-------------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| **Projects List**         | `/projects`                       | Redesigned table: Project Name, Source Language, Target Language, Source Bible, Milestones (count), Overall Progress. |
| **Project Detail**        | `/projects/:projectId`            | New hub page. Left: Meta Card + Project Team. Right: Milestones table with per-milestone progress and status badges.  |
| **Create Project Dialog** | (modal on `/projects`)            | Simplified: Title, Source Language/Bible, Target Language, Pericope Set, Connectivity Profile. No book selector.      |
| **Add Milestone Dialog**  | (modal on `/projects/:projectId`) | Repurposed: Milestone Name, Book Selector, Connectivity Profile override, scope warning (>5 books).                   |

### Existing Pages That Change

| Page                                             | Changes                                                                                                                                                                                                                              |
| :----------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Old Project Detail** (`ProjectDetailPage.tsx`) | Becomes **Milestone Detail**. Moves to `/projects/:projectId/milestones/:milestoneId`. "Export Project" → "Export Milestone". Meta card: adds "Project" field, removes language fields, adds "Books" field. Chapter table unchanged. |
| **`ProjectDetailWrapper.tsx`**                   | Currently assumes one unit via `chapterAssignments[0].projectUnitId`. Will receive `milestoneId` from URL params directly.                                                                                                           |
| **`ExportProjectDialog.tsx`**                    | Receives `projectUnitId` — no structural change, just receives the milestone-specific one.                                                                                                                                           |

### Translation Editor — No Changes Needed

The translation editor uses `ProjectItem.projectUnitId` to fetch verses, AI suggestions, and run checks. Since `project_units` rows are only re-parented (not deleted or restructured), all `projectUnitId` values remain stable.

---

## 6. Identified Risks & Mitigations

| Risk                                               | Impact                                                                            | Mitigation                                                                                             |
| :------------------------------------------------- | :-------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| **`baseJoinQuery` uses INNER JOINs**               | Projects with zero milestones disappear from the API                              | Change to LEFT JOINs. Handle NULL aggregations.                                                        |
| **`source_bible_id` NULL after failed backfill**   | Project detail page can't display Source Bible                                    | Make backfill mandatory. Verify 100% coverage before deploying new UI.                                 |
| **Re-parenting changes `project_units.projectId`** | Stale cached project IDs in frontend                                              | Invalidate query cache on deployment. Verify mobile app uses `projectUnitId` not `projectId` for sync. |
| **Merged user roles expand access**                | PM of one old project now has access to all milestones                            | Business decision — see Open Questions.                                                                |
| **Mobile app sync**                                | If mobile caches `projectId` values, re-parenting causes issues                   | Verify mobile uses `projectUnitId` for data sync (likely).                                             |
| **`POST /projects` API contract change**           | Mobile or other clients that send `bookId`/`bibleId` in create-project will break | Version the API or coordinate with mobile team for a synchronized release.                             |

---

## 7. Decisions Needed Before Implementation

### Must Decide Now

> [!IMPORTANT]
> **`project_units` Schema — Option A or B?** This blocks the migration script and the new milestones API.
>
> - _Option A:_ Strict columns (`name`, `type`, `connectivity_profile`) — simple, explicit, easy to query.
> - _Option B:_ `name` column + JSONB `metadata` for `type` and `connectivityProfile` — more flexible for future milestone-level settings we haven't thought of yet, mirrors the pattern `projects` already uses.

<!-- -->

> [!IMPORTANT]
> **Consolidated Project Naming:** This blocks the migration script. When merging old projects, what should the master be named?
>
> - _Option A:_ Name of the oldest project in the group.
> - _Option B:_ Auto-generate from the language pair (e.g., "English → Spanish").
> - _Option C:_ Let an admin rename after migration.

<!-- -->

> [!IMPORTANT]
> **Merging User Roles — Access Expansion:** This blocks the migration script. When 5 projects merge into 1, all their PMs and Translators share access to all milestones. A PM who managed only "Genesis Translation" now has PM access to everything under the merged project. Is this acceptable, or do we need milestone-level role scoping (significantly larger change)?
