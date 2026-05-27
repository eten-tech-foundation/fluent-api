# Cross-Schema Type Safety

## Problem

`fluent-api` (TypeScript / Drizzle) and `fluent-ai` (Python / SQLAlchemy + Alembic) share a single PostgreSQL database. Each service owns a distinct schema:

- `fluent-api` owns `public`, `pgboss`, `drizzle`
- `fluent-ai` owns `ai`

When `fluent-api` needs to read or write tables in the `ai` schema (e.g. `ai_suggestion_jobs`, `ai_suggestions`), Drizzle's query builder requires table definitions in the codebase. Previously these definitions were inlined in `src/db/schema.ts`, which created three problems:

1. **Schema ownership was unclear** — AI tables sat alongside public tables in the same file.
2. **Drizzle Kit generated migrations for AI tables** — even though they are managed by Alembic in `fluent-ai`.
3. **Schema drift risk** — changes in `fluent-ai` could silently diverge from the Drizzle stubs in `fluent-api`.

## Decision

Extract externally-owned schema stubs into a dedicated `src/db/external/` directory.

### What changed

- `src/db/external/ai-schema.ts` — read-only Drizzle stubs for the `ai` schema.
- `src/db/schema.ts` — no longer contains AI table definitions or the unused `aiSuggestionJobStatusEnum`.
- Consumers (`ai-suggestions.repository.ts`, `clean-ai-jobs.ts`) import AI tables from `@/db/external/ai-schema`.

### Why this approach

We evaluated several options:

| Approach | Verdict |
|---|---|
| **HTTP API boundary** | Overkill for same-DB data. Adds network hops, serialization, auth, and latency to solve a type-definition problem. |
| **Raw SQL + Zod** | Loses Drizzle joins and relational inference. More boilerplate, not less. |
| **Shared npm package** | Impossible — `fluent-ai` is Python, not Node.js. |
| **Views in `public`** | Breaks inserts/updates on `ai` tables that `fluent-api` legitimately writes to. |
| **Co-located stubs (`src/db/external/`)** | Keeps Drizzle type safety with minimal complexity. Makes ownership explicit. No new infrastructure. |

### Trade-offs

- **Staleness risk**: If `fluent-ai` changes a column, `fluent-api`'s stub becomes stale. Mitigation: regenerate from the database when schema changes occur.
- **Regeneration is manual today**: We do not yet automate introspection in CI. This is acceptable because the `ai` schema changes infrequently.

## Regenerating stubs

When `fluent-ai` migrates the `ai` schema, update the stubs:

```bash
npx drizzle-kit introspect --tables='ai.*' --out=./src/db/external/ai-schema.ts
```

Review the diff, commit, and run `npm run typecheck` before merging.

## Future considerations

- If the ecosystem grows and services split onto separate databases, the natural next step is an HTTP API boundary (or async events via PgBoss) rather than cross-database queries.
- If schema drift becomes painful, automate introspection in CI: run it after `fluent-ai` migrations, diff against the checked-in file, and fail the build on unexpected changes.
