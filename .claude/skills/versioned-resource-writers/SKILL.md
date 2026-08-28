---
name: versioned-resource-writers
description: Checklist for optimistic-lock / version-token write paths - use when adding or reviewing code that uses versionToken, optimistic locking, compare-and-swap updates, conflict detection, or optional request fields that change write semantics. Covers CAS correctness, Drizzle null-vs-undefined footguns, and legacy-client compatibility. Applies to src/**/*.{service,repository,route}.ts.
---

# Versioned resource writers

Use this checklist when adding or reviewing code that uses `versionToken`, optimistic locking, or compare-and-swap updates.

## Concurrency

1. **Every writer is a CAS** — updates that advance state must match the observed version in SQL (`WHERE version_token = expected`), not read-modify-write with an unconditional `UPDATE`.
2. **First-write / link paths need extra predicates** — e.g. `activeTakeId IS NULL` when linking the first take, so two concurrent first uploads cannot both claim active without conflict.
3. **Every state-mutating write bumps the token** — if one path links without bumping, a concurrent existing-unit writer that read the old token can still win its CAS and silently demote the first uploader.
4. **Resolve uses the same CAS as upload** — conflict resolution must not clobber a concurrent upload's state.

## ORM footguns (Drizzle)

- `undefined` in `.set()` means "omit column" — it does **not** clear to SQL `NULL`.
- Prefer explicit `null` when clearing nullable FK columns (e.g. `storageObjectId`).
- Flag `x ?? undefined` going into update payloads during review.

## Legacy / optional request fields

For optional fields that change write semantics (e.g. `baseVersionToken`):

| Field state | Semantics |
|-------------|-----------|
| Absent | Legacy last-writer-wins for the active take; do **not** clear an existing conflict |
| Present + matches | Happy path; may clear conflict |
| Present + stale | Keep both takes; mark conflict |

- Document all three in OpenAPI and add a legacy-client test (omitted field).
- Route parsing: empty form fields coerce to `0` — treat `''` as absent and require tokens `>= 1`.

## AI review hygiene

- **Blocking**: correctness, data loss, silent demotion, rollout breaks for legacy clients.
- **Non-blocking**: N+1 queries, dead helpers, naming — label as follow-up unless trivial.
- **Validate before flagging** — walk concurrent sequences against the current tip, not just the diff narrative.
