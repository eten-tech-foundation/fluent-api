---
name: versioned-resource-writers
description: Checklist for optimistic-lock / version-token write paths - use when adding or reviewing code that uses versionToken, optimistic locking, compare-and-swap updates, conflict detection, background prune/sweep deletes, or optional request fields that change write semantics. Covers CAS correctness, Drizzle null-vs-undefined footguns, and legacy-client compatibility. Applies to src/**/*.{service,repository,route}.ts.
---

# Versioned resource writers

Use this checklist when adding or reviewing code that uses `versionToken`, optimistic locking, or compare-and-swap updates.

## Concurrency

1. **Every state-advancing write is a CAS** — versioned clients match their supplied token in SQL (`WHERE version_token = expected`); the supported legacy path snapshots the current token when `baseVersionToken` is omitted and uses that value as `expected`. Neither path may use an unconditional `UPDATE`.
2. **First-write / link paths need extra predicates** — e.g. `activeTakeId IS NULL` when linking the first take, so two concurrent first uploads cannot both claim active without conflict.
3. **Every write that advances state bumps the token** — if a link or replace path skips the bump, a concurrent writer who read the old token can still win its CAS and silently demote the first one. Flagging a conflict without changing what the resource points at is the exception: it does not invalidate anyone's token.
4. **Resolve uses the same CAS as upload** — conflict resolution must not clobber a concurrent upload's state.
5. **Clearing a conflict is its own operation** — if writes could also clear it, the client that caused the conflict settles it by retrying with the token the conflict response handed back. Let write paths raise the flag and only an explicit resolve lower it.
6. **Sweeps that delete are CAS too** — a background prune must re-check "still unreferenced" inside the deleting statement, under a lock on the parent row, not trust the snapshot it listed from. Delete rows and let a later grace-guarded pass free the bytes, so a concurrent re-upload cannot have its revived object collected.

## ORM footguns (Drizzle)

- `undefined` in `.set()` means "omit column" — it does **not** clear to SQL `NULL`.
- Prefer explicit `null` when clearing nullable FK columns (e.g. `storageObjectId`).
- Flag `x ?? undefined` going into update payloads during review.

## Legacy / optional request fields

For optional fields that change write semantics (e.g. `baseVersionToken`):

| Field state         | Semantics                                   |
| ------------------- | ------------------------------------------- |
| Absent              | Legacy last-writer-wins for the active take |
| Present + matches   | Happy path; replace the active take         |
| Present + stale     | Keep both takes; mark conflict              |
| Present + malformed | `400` — never fold it into the legacy path  |

None of these clears an existing conflict; see concurrency rule 5.

The omitted-token legacy path is a **deprecated** compatibility hatch. Upload logs `verse_audio_upload_legacy_no_token` so we can measure remaining use before removing it.

- Document all four in OpenAPI and add a legacy-client test (omitted field).
- Route parsing: empty form fields coerce to `0` — treat `''` as absent and require tokens `>= 1`. Where the framework validates a body it never sees (multipart read through `parseBody`), the declared schema is documentation only: validate in the handler.

## Client conflict responses (verse audio)

| HTTP  | Body signal                  | Meaning                                                                                                                                                                               |
| ----- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200` | `conflictStatus: 'conflict'` | Normal offline / stale-token upload — both takes kept; client resolves explicitly                                                                                                     |
| `409` | `currentVersionToken?`       | CAS or storage cleanup race — retry with `baseVersionToken` set from `currentVersionToken` (same value as `versionToken` on a GET). Field omitted only when the recording row is gone |

Do not treat `409` as the offline conflict path, and do not treat `200` + conflict as a blind retry loop.

Mirrored from `.cursor/rules/versioned-resource-writers.mdc` — keep the two in sync.
