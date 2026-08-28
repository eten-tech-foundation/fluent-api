# Claude Code — Fluent API

## Versioned resource writers

When working on optimistic-lock / `versionToken` paths (services, repositories, routes), apply this checklist before claiming a PR is merge-ready.

### Concurrency

1. Every writer that advances state uses compare-and-swap (`WHERE version_token = expected`).
2. First-write / link paths include extra uniqueness predicates (e.g. `activeTakeId IS NULL`).
3. Every state-mutating write bumps the version token — including first-upload link.
4. Resolve endpoints use the same CAS pattern as uploads.

### Drizzle / ORM

- `undefined` in `.set()` omits the column; use explicit `null` to clear nullable FKs.
- Watch for `x ?? undefined` in update payloads.

### Optional version fields (legacy compat)

- **Absent** → legacy replace active take; preserve existing conflict status.
- **Present + match** → happy path; may clear conflict.
- **Present + stale** → keep both takes; mark conflict.

Document all three in OpenAPI. Parse route form fields carefully: `Number('') === 0` — treat empty strings as absent; tokens start at `1`.

### Review triage

- Blocking: correctness, data loss, silent take demotion, legacy rollout breaks.
- Non-blocking: perf nits, dead code — unless trivial to fix in the same PR.
- Validate concurrency scenarios against current code before requesting changes.

See also: `.cursor/rules/versioned-resource-writers.mdc` (shared checklist for Cursor).
