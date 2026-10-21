# Code standards

The rules every fluent-api change must follow, each with an ID. ARCHITECTURE.md explains
the design behind them; this page is the checklist. Where the two disagree, fix whichever
is wrong in the same PR.

- **FA-L\*** — enforced by `npm run lint`. The message names the rule ID.
- **FA-C\*** — enforced by another CI check.
- **FA-R\*** — not machine-checkable. The author (human or agent) checks the diff against
  them before asking for review; reviewers cite the ID.

## Before opening a PR

1. `npm run verify` — lint, format, typecheck, tests, dead code, docs structure, build. It must pass.
2. Walk the [FA-R checklist](#fa-r-review-checklist) against your diff
   (`git diff origin/main...`). Fix what applies; say in the PR body why any item you
   knowingly didn't follow is an exception.
3. Draft PRs run the Code standards and Docs Structure Check
   [CI jobs](../../.github/workflows/pre-merge.yml) too, so check them before marking the PR
   ready.

## FA-L: lint rules

| ID     | Rule                                                                                                                                                                                            | Fix                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| FA-L1  | Never import another domain's repository — from a service, middleware, route, or anything outside `src/domains` (`src/middlewares`, workers).                                                   | Call a function exported from that domain's `.service.ts`. If none fits, add one there.                                     |
| FA-L2  | At most one `*.repository.ts` per directory: one per domain or sub-domain leaf.                                                                                                                 | Give a resource with its own queries its own leaf directory (see ARCHITECTURE.md, Sub-Domain Leaves).                       |
| FA-L3  | `*.route.ts` never imports `@/db`, `drizzle-orm`, or any `*.repository`.                                                                                                                        | Move the query into a repository and call it through a service.                                                             |
| FA-L4  | `*.route.ts` has no `Promise.all`/`allSettled`/`any`/`race`. A handler makes one service call.                                                                                                  | Move the fan-out, join or filtering into the leaf's service.                                                                |
| FA-L5  | Status codes in routes are `HttpStatusCodes.*`, never numeric literals — in `c.json(...)` and in `responses` keys.                                                                              | `import * as HttpStatusCodes from 'stoker/http-status-codes'`.                                                              |
| FA-L6  | No explicit `any`, tests included (`ts/no-explicit-any`).                                                                                                                                       | A real type, `unknown` plus narrowing, `vi.mocked()`, or a complete fixture/factory.                                        |
| FA-L7  | Unit tests (`*.test.ts`) never `vi.mock('@/db')`.                                                                                                                                               | Mock the repository. Tests that need real SQL are `*.integration.test.ts` on PGlite, where replacing `@/db` is allowed.     |
| FA-L8  | A domain imports its own repository as a namespace: `import * as repo from './x.repository'`. `import type { … }` is fine.                                                                      | Switch to the namespace import.                                                                                             |
| FA-L9  | `*.service.ts` never `throw`s. Business failures are `err(ErrorCode.X)`.                                                                                                                        | To roll a transaction back, return `err()` from `runInTransaction` (`@/db/transaction`); see [Transactions](#transactions). |
| FA-L10 | Every `eslint-disable` comment says why (`-- reason`).                                                                                                                                          | Add the reason, or fix the code instead.                                                                                    |
| FA-L11 | Files stay under 500 lines (1500 for `schema.ts`); warnings fail lint (`--max-warnings 0`).                                                                                                     | Split by resource or responsibility.                                                                                        |
| FA-L12 | Object shapes are `interface`; `type` is for everything else (`ts/consistent-type-definitions`). See [Types](#interface-vs-type).                                                               | `lint:fix` converts them.                                                                                                   |
| FA-L13 | HTTP methods are all caps (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) in every string: test titles, OpenAPI text, log messages. Test titles may start with one (`describe('POST /projects', …)`). | Uppercase the whole method. `lint:fix` keeps a leading method as written.                                                   |

## FA-C: other CI checks

| ID    | Rule                                                                            | Command                           |
| ----- | ------------------------------------------------------------------------------- | --------------------------------- |
| FA-C1 | No new dead code: unused files, exports, exported types or dependencies (knip). | `npm run deadcode`                |
| FA-C2 | `docs/` keeps its directory structure.                                          | `scripts/check-docs-structure.sh` |

## FA-R: review checklist

Each item comes from a recurring review comment.

| ID     | Check                                                                                                                                                                                                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FA-R1  | **Reuse before writing.** Search for an existing helper, schema or constant before adding one (`rg` for the concept, not just the name). A request schema or helper used by more than one file goes in `{domain}.types.ts` or a shared `lib/` module. Use domain constants (`CHAPTER_ASSIGNMENT_STATUS.DRAFT`, `QUEUE_NAMES.X`) instead of their string values. |
| FA-R2  | **Routes return response schemas, never repository rows.** The service maps rows to the zod-inferred response type before they reach `c.json`.                                                                                                                                                                                                                  |
| FA-R3  | **Contracts match behavior.** Declared OpenAPI responses cover every status the middleware chain can return (e.g. `authenticateUser` can 403). When behavior changes, update OpenAPI `description`s, test titles, doc comments and `docs/` in the same PR.                                                                                                      |
| FA-R4  | **Authorization:** 404 when the resource is missing or the caller can't read it; 403 when the caller can read it but the action is denied, or for an endpoint-level permission. A failed lookup returns its own status, never a blanket 404. See [403 or 404](#403-or-404). A new or changed policy method updates the table in `docs/permissions.md`.          |
| FA-R5  | **Business rules live in services.** Repositories run queries; deciding eligibility, picking which record wins or gating on feature flags belongs in the service.                                                                                                                                                                                               |
| FA-R6  | **State changes keep their audit trail.** Any write that changes chapter-assignment status or assignee also writes the matching history table, as every other writer does.                                                                                                                                                                                      |
| FA-R7  | **Queries are deterministic and safe.** `.limit()` comes with an `orderBy`. User text going into `like`/`ilike` has `%`, `_` and `\` escaped. A nullable column used as a watermark filter can't silently exclude `NULL` rows.                                                                                                                                  |
| FA-R8  | **Nothing is dropped silently.** Any branch that skips an input (a failed `safeParse` filter, an unmatched row, an unsupported node) logs it at `warn` with enough context to find it.                                                                                                                                                                          |
| FA-R9  | **Drizzle updates:** `undefined` in `.set()` leaves the column unchanged; use `null` to clear it. Flag `x ?? undefined` going into an update. Version-token writes follow `.claude/skills/versioned-resource-writers/SKILL.md`.                                                                                                                                 |
| FA-R10 | **Independent awaits run concurrently** (`Promise.all`, in the service). Sequential `await` in a loop needs a reason: ordering, rate limits, or per-item failure isolation.                                                                                                                                                                                     |
| FA-R11 | **Tests prove the change.** Both `ok` and `err` paths are covered. Fixtures come from factories, not partial casts (`{ id: 2 } as X`). The test that proves the PR's central invariant runs in `npm test`; a `*.db.test.ts` or `skipIf` suite doesn't count.                                                                                                    |
| FA-R12 | **No dead code in the diff.** Delete what the change made unused (constants, parameters, helpers, and mocks that no longer match the code).                                                                                                                                                                                                                     |

## Decisions

### Cross-domain access

Everything outside a domain calls its service, including middleware and shared
infrastructure. That covers `user-roles` (grants, org membership) and
`projects/workflow-stages`, which auth middleware used to read straight from the
repository. Pass `tx` into the service function when the call joins a transaction.

### 403 or 404

Return 404 when the caller can't see the resource, so a denial and a missing record look
the same; IDs are sequential, and a 403 tells a caller from another org that the ID exists.
Return 403 when the caller can see the resource but not do this to it. This is GitHub's
model for private repositories.

| Situation                                                               | Status                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Resource doesn't exist                                                  | 404                                                                  |
| Caller can't read the resource                                          | 404                                                                  |
| Caller can read it, but the action (update, delete, claim, …) is denied | 403                                                                  |
| Endpoint-level permission with no specific resource (list, create)      | 403                                                                  |
| The lookup failed (database error)                                      | the error's own status via `getHttpStatus`, 500 for `INTERNAL_ERROR` |

Clients rely on this: a sync client treats 404 as "gone", so it drops local data when a
record is deleted or the user loses access. A 404 for a denied update tells it to delete a
record the user can still read, and a 404 for a database error deletes data over a blip.

### Transactions

Services don't throw (FA-L9). Throwing is still how Drizzle rolls back a transaction, so the
throw lives in exactly one place:

```typescript
import { runInTransaction } from '@/db/transaction';

function addBooksToMilestone(
  projectId: number,
  milestoneId: number,
  bibleId: number,
  bookIds: number[]
) {
  return runInTransaction(async (tx) => {
    const existing = await repo.getExistingBookAssignmentsForProject(projectId, bookIds, tx);
    if (existing.some((a) => !a.deletedAt)) return err(ErrorCode.VALIDATION_ERROR); // rolls back

    await repo.insertBibleBookLinks(
      bookIds.map((bookId) => ({ projectUnitId: milestoneId, bibleId, bookId })),
      tx
    );
    const assignments = await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
      milestoneId,
      bibleId,
      bookIds,
      tx
    );
    if (!assignments.ok) return assignments; // rolls back; the error passes through unchanged

    return ok(assignments.data); // commits
  });
}
```

Pass an outer `tx` as the second argument to nest: an `err()` then rolls back only the
inner savepoint. Unexpected exceptions still roll back and propagate. Don't encode error
codes in `new Error('CODE')` messages and string-match them in a `catch`.

### `interface` vs `type`

- **`interface`** for every object shape: entities, service inputs, policy inputs,
  repository row shapes. Extend with `extends`.
- **`type`** for unions, intersections, mapped and conditional types, function types,
  tuples, and aliases of other types (`Pick`, `Omit`, `Extract`).
- **Zod is the source of truth for anything validated at runtime:**
  `type X = z.infer<typeof xSchema>`. Don't hand-write an interface that duplicates a schema.

### Repositories

One `*.repository.ts` per domain or sub-domain leaf directory (FA-L2). A leaf keeps its
queries next to its routes and services, and files stay at a readable length.

## Grandfathered violations

Violations that existed when a rule was adopted are recorded, not fixed.

- **Lint:** `eslint-suppressions.json` holds a count per file and rule, not each violation's
  location. A file can't gain violations of a rule, but swapping one recorded violation for a
  new one in the same file passes, so reviewers still check new code in grandfathered files.
  Fixing a recorded violation fails lint until you run `npm run lint:prune` and commit the
  smaller file, so the counts only go down. Never run `eslint --suppress-all` to make a new
  violation pass.
- **Dead code:** `knip-baseline.json` works the same way. After removing dead code, run
  `npm run deadcode -- --update` to drop the entries that no longer occur; it refuses to run
  while there is new dead code, so it can't add entries.

## Follow-up PRs

Each item is its own PR. None of them goes into an unrelated change as a drive-by.

1. **HTTP method casing (FA-L13), #414.** Uppercase the 33 grandfathered mangled methods
   (`pOST`, `gET`, …), mostly in `describe` titles, and run `npm run lint:prune`. The
   lowercase-title autofix produced them; `allowedPrefixes` now prevents that.
2. **Transactions (FA-L9), #415.** Move `milestones`, `projects` and `chapter-assignments`
   services onto `runInTransaction`. Replace `throw new Error('CODE')` and the
   `error.message === 'CODE'` matching in their `catch` blocks with `return err(...)`, then
   prune the FA-L9 suppressions.
3. **403 for denied actions on a readable resource (FA-R4), #416.** Resource middlewares
   return 404 for every denied action. Keep 404 when read is denied and return 403 when the
   caller can read the resource but the action is denied; `ai-suggestions` returns 403 when
   read is denied and moves to 404. Clients will see this change: update the OpenAPI
   responses, `docs/permissions.md`, and tell the web and mobile clients.
4. **Cross-domain repository access (FA-L1), #417.** Add service functions to `user-roles` and
   `projects/workflow-stages` and move the auth middlewares and other callers onto them.
5. **404 on lookup errors (FA-R4), #419.** Some auth middlewares return 404 for any failed
   lookup, including database errors, and for malformed IDs. Return the error's own status
   and 400 for a malformed ID.
6. **Active-org route (FA-L3), #425.** `PATCH /users/me/active-org` runs its own transaction
   in the route. Move it into the users service on `runInTransaction`, and mock the service
   instead of `@/db` in its test.
