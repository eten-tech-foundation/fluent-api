# API #434 — displayMode + atomic `/self/settings` merge

**Status:** implemented in worktree (no commit/push from this lane)
**Approved contract:** `/tmp/api434-approved-body.md` (2026-10-21)
**Baseline note:** API main at approval `c8d4cb6a54da3bdcecfb5a58f4ef868d03163df1`

## Contract (wire)

- `GET`/`PUT /self/settings` (authenticated session user)
- PUT body `{ settings: { … } }`
- Response `{ settings: <normalized>|null, updatedAt: string|null, settingsCapabilities: { partialMerge: true, displayMode: true } }`
- Optional stored key `displayMode?: 'verse' | 'pericope'`
- Explicit `displayMode: null` deletes **only** that key (omitted when normalized)
- Absent keys untouched; `PUT { settings: {} }` no-op (`mergePatch` not called)
- Legacy `{ checkIgnoredWordPairs }` / `{ checkIgnoredWordPairs: {} }` preserve `displayMode`
- Invalid enum → **422**; unknown keys stripped
- Same-key: last successfully server-saved write; no clocks/ETags/new endpoint

## Implementation

| Area                                   | Change                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/db/schema.ts`                     | `displayMode` on read object; write schema allows `null` deletes; merge comments   |
| `self-settings.repository.ts`          | `mergePatch` — one upsert: `jsonb_strip_nulls(COALESCE(existing,'{}') \|\| patch)` |
| `self-settings.service.ts`             | Empty patch → find-only no-op; capabilities on every response                      |
| `self-settings.types.ts` / `.route.ts` | Response + OpenAPI capabilities + merge descriptions                               |

**API #424 overlap (read-only):** PR #424 is modularization / verse-audio CAS concurrency tests — not settings JSONB merge. No duplication.

**Out-of-leaf edits:** `src/db/schema.editor-state-extension.test.ts` (existing settings schema tests), `eslint-suppressions.json` (pruned stale `any` counts; FA-L7 `@/db` mock remains ×1 — reviewer-approved scoped prune).

## Tests / gates run (final)

```bash
./node_modules/.bin/vitest run \
  src/domains/self/settings \
  src/db/schema.editor-state-extension.test.ts \
  --maxWorkers=2
# → 3 files, 40 tests passed

npm run lint                    # exit 0
npm run format:check            # exit 0
./node_modules/.bin/tsc --noEmit  # exit 0
./scripts/check-docs-structure.sh # exit 0
npm run build                   # exit 0 (tsc && tsc-alias)
```

| Suite                                          | Count | What it proves                                                                                                                                          |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `self-settings.route.test.ts`                  | 19    | Merge/delete/no-op (`mergePatch.not.toHaveBeenCalled` after `PUT {}`), legacy preservation, capabilities, 422, isolation, same-key LWW, 500 on repo err |
| `schema.editor-state-extension.test.ts`        | 18    | Schema displayMode + null delete + strip/reject                                                                                                         |
| `self-settings.repository.integration.test.ts` | 3     | Real JSONB SQL on **PGlite** (merge/delete; ON CONFLICT under single-connection scheduling; same-key LWW)                                               |

### `npm run verify` — not executed (gate gap)

Inspected: `verify` = `precheck` (lint + format:check + typecheck + `vitest`) + `deadcode` + docs structure + `build`.

**Stopped before `npm run verify` / `npm run deadcode`:** `scripts/check-dead-code.mjs` invokes `npx knip …`, and `knip` is **absent** from the linked `node_modules` (`node_modules/knip` missing). Running that step would risk a dependency download, which is disallowed. Safe pieces above were run individually instead.

## Limitations / missing proof

- **No `npm run test:db`:** no verified isolated local `DATABASE_URL`. Did not touch shared Dev/QA.
- **PGlite ON CONFLICT scheduling ≠ multi-session Postgres:** overlapping `Promise.all` on one PGlite client is not a two-session race. Missing: isolated Postgres with concurrent clients against `user_settings`.
- Full `npm run verify` blocked on missing local `knip` (see above).
- No live QA mutation, devices, Metro, or network requests.
- Mobile #754 / PR 760 capability gate is out of this repo.

## FA-R verdicts (`git diff` + untracked settings/receipt files)

| ID     | Verdict | Notes                                                                                                                              |
| ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| FA-R1  | **ok**  | Extended existing `userSettings*` schemas; capabilities constant in leaf types; no parallel helper invented                        |
| FA-R2  | **ok**  | Service `toResponse` maps repo rows → `UserSettingsResponse` before `c.json`                                                       |
| FA-R3  | **ok**  | OpenAPI response/descriptions updated; route + schema tests + receipt match merge/no-op/capabilities                               |
| FA-R4  | **n/a** | Auth unchanged (`authenticateUser`); no new policy / permissions table rows                                                        |
| FA-R5  | **ok**  | Empty-patch no-op decision in service; SQL merge stays in repository                                                               |
| FA-R6  | **n/a** | Not chapter-assignment status/assignee                                                                                             |
| FA-R7  | **ok**  | `findByUser` uses PK equality + `.limit(1)`; no `like`/`ilike`                                                                     |
| FA-R8  | **n/a** | Unknown-key strip is declared Zod contract, not a silent skip branch                                                               |
| FA-R9  | **ok**  | Blob update via parameterized SQL merge/strip-nulls; no `x ?? undefined` into `.set()`                                             |
| FA-R10 | **n/a** | Single repo call per write; no service fan-out                                                                                     |
| FA-R11 | **ok**  | Central merge/no-op/capabilities invariants in `*.route.test.ts` (npm-test path); ok+err (422/500); PGlite SQL proof supplementary |
| FA-R12 | **ok**  | Replaced full-replace `upsert` with `mergePatch`; removed unused full-replace types/comments                                       |
