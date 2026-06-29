# Transition Plan — HTTP-only decoupling from `fluent-ai` (API side)

**Audience:** the developer working the decoupling ticket in `fluent-api`.
**Status:** approved design, ready to implement.
**Companion doc:** `fluent-ai/docs/http-decoupling-transition.md` (the AI-side half).

## Why this change

Today `fluent-api` and `fluent-ai` are coupled through a **shared PostgreSQL
database** rather than a network contract:

- `fluent-api` **writes** the AI work queue by inserting rows into
  `ai.ai_suggestion_jobs` cross-schema, using the Drizzle stubs in
  `src/db/external/ai-schema.ts`.
- `fluent-api` **reads** AI results cross-schema from `ai.ai_suggestions`.
- `fluent-api` **writes** `ai.ai_suggestion_usage_log` cross-schema.
- `fluent-ai`, in the other direction, **reads** six `public` tables
  (`bible_texts`, `books`, `languages`, `projects`, `project_units`,
  `translated_verses`) via a read-only DB role.

This makes the two services one deployable unit in disguise: schema changes on
either side can silently break the other, and neither can move to its own
database.

### Target

The **only** communication between the two services is HTTP.

```
                 (1) trigger: POST /suggestions  → 202
   ┌─────────┐ ──────────────────────────────────────► ┌─────────┐
   │ fluent  │                                           │ fluent  │
   │  -api   │ ◄─────────────────────────────────────── │  -ai    │
   └─────────┘ (2) input pull: GET internal context     └─────────┘
        ▲       ◄───────────────────────────────────────
        │       (3) result push: POST internal suggestions
        │
   client → GET /ai-suggestions  (polling, unchanged)
```

No SSE / WebSockets. The client continues to discover finished suggestions by
**polling** the existing read endpoint — that contract does not change.

## Decisions already made (do not re-litigate)

| Topic                        | Decision                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Translation-memory retrieval | **API runs the FTS/TM query server-side** and returns ready-to-use context to AI over HTTP. The heavy SQL stays where the data lives. |
| How API triggers AI          | **API enqueues its own pg-boss job after commit; a worker makes the HTTP call.** No network call inside the request DB transaction.   |
| AI's queue                   | AI keeps a **general-purpose** job table in its own schema. The API never touches it.                                                 |
| Existing AI data             | **Greenfield** — `ai.ai_suggestions` / `ai.ai_suggestion_usage_log` can be dropped and recreated under API ownership. No backfill.    |

## Scope of API-side work

Four workstreams, roughly in dependency order:

1. Bring the AI result tables under API ownership (schema + repository).
2. Add the **outbound trigger** path (pg-boss job → HTTP client to AI).
3. Add the **inbound internal endpoints** AI calls (context pull + result push),
   behind a new service-to-service auth seam.
4. Delete all cross-schema coupling.

---

### Workstream 1 — Own the result tables

Currently `ai_suggestions` and `ai_suggestion_usage_log` live in the `ai`
schema and are reached through `src/db/external/ai-schema.ts`. Move them into
API-owned Drizzle schema (`public`).

- Add `ai_suggestions` and `ai_suggestion_usage_log` table definitions to
  `src/db/schema.ts` (these are now first-class API tables, not external stubs).
  Keep the same columns the repository already uses: `bibleTextId`,
  `projectUnitId`, `suggestedText`, `modelInfo`, `createdAt`; and for usage:
  `userId`, `bibleTextId`, `projectUnitId`, `wasUsed`, `createdAt`, with the
  existing unique constraints.
- Generate a Drizzle migration that creates these tables in `public`. Because
  this is greenfield, you do **not** need to copy data out of `ai.*`.
- Update `src/domains/ai-suggestions/ai-suggestions.repository.ts`:
  - Change the imports of `ai_suggestions` / `ai_suggestion_usage_log` from
    `@/db/external/ai-schema` to `@/db/schema`.
  - **Remove** `queueAiSuggestionJobs` and the `ai_suggestion_jobs` import
    entirely — the API no longer enqueues by DB insert (replaced in
    Workstream 2).
  - Keep `getAiSuggestions`, `logAiSuggestionUsage`, the auth-context and
    threshold helpers (these all read API-owned `public` tables and are
    unaffected).
- `GET /ai-suggestions` and `POST /ai-suggestions/usage` now hit API-owned
  tables. No route changes needed beyond the repository swap.

### Workstream 2 — Outbound trigger (pg-boss job → HTTP)

Today the trigger is a cross-schema INSERT, and critically it runs **inside the
chapter-assignment DB transaction** (`handleChapterAssigned` is awaited from
`chapter-assignments.service.ts` at three call sites, and `queueNextVerses` is
called from the `/ai-suggestions/queue-next` route). A network call must not
live inside a DB transaction, so we move the trigger to an **outbox-style
pg-boss job** that fires after commit.

Keep the _decision_ logic where it is — `hasReachedAiActivationThreshold`,
`getChapterAssignmentAiStatus`, `findNextUntranslatedVerses`,
`queueNextVersesForAssignment`. These read API-owned data and stay in
`ai-suggestions.service.ts`. Only the final step changes: instead of
`queueAiSuggestionJobs(jobs)` writing to `ai.ai_suggestion_jobs`, enqueue a
pg-boss job carrying the same job specs.

- Add a queue name + payload type in `src/lib/queue.ts`, e.g.
  `QUEUE_NAMES.AI_SUGGESTION_TRIGGER`, payload shape matching the existing job
  rows: `{ projectUnitId, bibleId, bookCode, chapterNumber, verseStart,
verseEnd }[]` (batch them into one job to preserve the current "queue several
  verses at once" behavior).
- Add a worker (mirroring `src/workers/usfm-export.worker.ts`) that consumes
  that queue and POSTs the job specs to AI's trigger endpoint
  (`POST /suggestions`, see AI doc) using a small HTTP client.
- Add an **AI HTTP client** under `src/lib/` (e.g. `ai-client.ts`) wrapping
  `fetch`/`undici`, reading base URL + API key from env. It sends the AI API
  key as `X-API-Key` (AI's existing auth scheme — see `fluent-ai`
  `security/auth.py`).
- Add env vars to `src/env.ts`: `AI_SERVICE_BASE_URL`, `AI_SERVICE_API_KEY`
  (plus the existing `AI_*` tuning vars stay).
- In `ai-suggestions.service.ts`, replace the `queueAiSuggestionJobs(...)` call
  with a `boss.send(QUEUE_NAMES.AI_SUGGESTION_TRIGGER, payload)`. Because
  pg-boss writes to the `pgboss` schema (API-owned), this is **not** cross-schema
  and can be enqueued safely. Note the transactional subtlety below.

> **Transactional note (call out in PR):** `handleChapterAssigned` currently
> runs inside the same transaction as chapter-assignment creation, so the
> enqueue was atomic with the assignment. With pg-boss the cleanest options are
> (a) enqueue after the transaction commits (simple, tiny risk of an
> assignment created but trigger lost if the process dies in the gap), or
> (b) a true outbox: write an `outbox` row in the same tx, with a sweeper that
> publishes to pg-boss. Recommend (a) for v1 and note (b) as a follow-up;
> AI-side dedup (see below) makes a duplicate or replayed trigger harmless, and
> a lost trigger is self-healing on the next `queue-next` poll from the client.

### Workstream 3 — Inbound internal endpoints (AI → API)

AI now pulls its inputs and pushes its outputs over HTTP. Add a new internal
domain/route group (suggested: `src/domains/ai-internal/` or extend
`ai-suggestions` with an `*.internal.route.ts`) exposing:

**(a) Context endpoint — replaces all six cross-schema reads.**

`POST /internal/suggestion-context` (POST so the verse range + project unit go
in the body cleanly). Given `{ projectUnitId, bibleId, bookCode, chapterNumber,
verseStart, verseEnd }`, it returns everything the AI worker needs in one shot:

- the **source verses** in range (text + verse numbers) — from `bible_texts`;
- the **translation-memory context verses** — run the hybrid FTS + proximity
  query server-side (this is the logic currently in `fluent-ai`'s
  `context_retrieval.py`; it is being **moved into the API** because the API
  owns `bible_texts` + `translated_verses`);
- the **target language name** — the join `project_units → projects →
languages` currently done in AI's `_resolve_target_language_name`.

Returning all three together minimizes round-trips (one call per job).

> **This is the largest single piece of new work.** Port the hybrid retrieval
> SQL from `fluent-ai/src/app/services/context_retrieval.py` into a new API
> repository function. Coordinate with the AI dev so the request/response
> contract matches exactly what their worker builds the prompt from (verse id
> format `BOOK_chapter_verse`, context-verse dict shape, `limit` =
> `MAX_CONTEXT_VERSES_TOTAL`).

**(b) Result endpoint — replaces AI's INSERT into `ai.ai_suggestions`.**

`POST /internal/ai-suggestions` accepting a batch:
`{ jobRef?, items: [{ bibleTextId, projectUnitId, suggestedText, modelInfo }] }`.
The handler upserts into the API-owned `ai_suggestions` table (same
`onConflictDoUpdate` on `(bibleTextId, projectUnitId)` the AI worker uses
today). Persist synchronously for v1; if write volume warrants it later, hand
off to a pg-boss job ("API can do this via async thread or job"). Make it
**idempotent** — AI may retry this POST.

**Service-to-service auth (net-new — flag prominently):** the API only has
**BetterAuth session-based** auth for human users today
(`src/middlewares/role-auth.ts`). These internal endpoints are called by a
machine, not a browser session. Add a separate auth seam:

- a `requireServiceAuth` middleware that validates a shared service key /
  bearer token (env `AI_INBOUND_SERVICE_KEY`), entirely separate from the user
  session middleware;
- mount the `/internal/*` routes behind it and **exclude them from any user
  session/CSRF handling**;
- do not expose `/internal/*` in the public OpenAPI surface intended for
  clients.

Decide with the team whether the AI→API key and the API→AI key are the same
shared secret or two distinct keys (recommend **two distinct keys**, one per
direction, so either can be rotated independently).

### Workstream 4 — Delete the cross-schema coupling

Once 1–3 are in place and tested:

- Delete `src/db/external/ai-schema.ts` and the `src/db/external/` directory if
  empty.
- Confirm no remaining imports from `@/db/external/ai-schema` (the repository
  swap in WS1 and the trigger swap in WS2 should remove them all).
- `src/scripts/clean-ai-jobs.ts` currently deletes rows from
  `ai.ai_suggestion_jobs`. The job table now belongs to AI — **delete this
  script** from `fluent-api` (job cleanup moves to AI; see AI doc).
- Remove the DB grants that let the API touch the `ai` schema (coordinate with
  whoever owns DB role provisioning). After this, the API role should have **no
  access** to the `ai` schema at all.
- Update `docs/cross-schema-types.md` — it documents the very pattern we are
  removing. Either delete it or replace it with a short note pointing at this
  transition doc and stating that API↔AI is now HTTP-only.
- Update `ARCHITECTURE.md` to describe the AI integration as an external HTTP
  dependency rather than shared-schema tables.

---

## Suggested sequencing

1. **WS3 (a) context endpoint** first — it's the long pole and unblocks the AI
   dev, who can start consuming it behind a flag while their cross-schema reads
   still exist as a fallback.
2. **WS1** result tables + **WS3 (b)** result endpoint — lets AI write results
   over HTTP.
3. **WS2** outbound trigger — flips API from DB-insert enqueue to HTTP trigger.
4. **WS4** delete coupling — only after both services are fully on HTTP in a
   shared environment and the end-to-end path is verified.

Each step is independently shippable; the cross-schema path keeps working until
WS4, so you can cut over incrementally rather than big-bang.

## Open questions to resolve with the AI dev / team

1. **Exact context contract.** Verse-id format, context-verse dict shape, and
   the `limit` semantics must match between the API endpoint and AI's prompt
   builder. Pair on this before either side codes it.
2. **One key or two?** Recommend two directional service keys. Confirm where
   they're stored/rotated.
3. **Trigger atomicity.** Confirm "enqueue after commit" (option a) is
   acceptable for v1, or whether a DB outbox is required now.
4. **Does AI still share the same Postgres instance?** Not required after this
   change — AI's job table can live in a separate DB. Out of scope for the API
   work, but it informs whether the `ai` schema lingers in the shared instance.
5. **Result endpoint granularity.** Per-verse vs per-job batch POST — agree on
   batch to match the worker's per-job completion.

## Definition of done (API side)

- API enqueues AI work via pg-boss → HTTP; no code inserts into
  `ai.ai_suggestion_jobs`.
- API exposes authenticated `/internal/suggestion-context` and
  `/internal/ai-suggestions` endpoints; AI consumes both.
- `ai_suggestions` / `ai_suggestion_usage_log` are API-owned `public` tables;
  `GET /ai-suggestions` and usage logging read/write them with no cross-schema
  access.
- `src/db/external/ai-schema.ts` and `clean-ai-jobs.ts` are deleted; the API DB
  role has no `ai`-schema grants.
- Docs (`cross-schema-types.md`, `ARCHITECTURE.md`) updated.
