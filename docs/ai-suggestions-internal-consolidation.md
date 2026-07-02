# Design — Fold `ai-internal` into `ai-suggestions`

**Audience:** whoever picks up the follow-up cleanup after `draft/ai-suggestions`.
**Status:** proposed design — not yet implemented. See "Rollout" before starting.
**Related:** `docs/http-decoupling-transition.md`, `docs/ai-suggestions-workflow.md`, `docs/cross-schema-types.md`, `ARCHITECTURE.md`.
**Companion:** `fluent-ai/docs/http-decoupling-transition.md`. The two endpoints this doc moves are called exclusively by that service's worker (`suggestion_processor.py`), so this is a wire-contract change — coordinate before merging.

## Why

`draft/ai-suggestions` shipped the AI-suggestions feature as **two** top-level domains:

- `domains/ai-suggestions/` — user-facing: `GET /ai-suggestions`, `POST /ai-suggestions/queue-next`, `POST /ai-suggestions/usage`. Session auth (`authenticateUser`).
- `domains/ai-internal/` — machine-facing: `POST /internal/suggestion-context`, `POST /internal/ai-suggestions`. Service-key auth (`requireServiceAuth`).

That split is an internal/public API drawn along "who calls it," not "what it owns" — the thing we're trying to avoid per `ARCHITECTURE.md`'s domain-boundary rules. Concretely:

- **Duplicate table ownership.** `ai-internal.repository.ts::upsertAiSuggestions` and `ai-suggestions.repository.ts::getAiSuggestions` / `logAiSuggestionUsage` both read/write `ai_suggestions` from two different domain folders. `ARCHITECTURE.md`'s Cross-Domain Relationships section says repositories shouldn't be reachable from outside their own domain — here there are two domains both claiming to be "inside" for the same table.
- **Inconsistent error handling.** Every other domain (including `ai-suggestions.service.ts` itself) returns `Result<T>` and lets the route layer call `getHttpStatus`. `ai-internal` throws raw `Error`s and does `error.name === 'ZodError'` string checks instead.
- **No test coverage.** `ai-suggestions` has both repository and route tests; `ai-internal` has none.
- **The original transition doc already named this alternative.** `docs/http-decoupling-transition.md` (Workstream 3) proposed either "a new internal domain/route group (suggested: `src/domains/ai-internal/`" **or** "extend `ai-suggestions` with an `*.internal.route.ts`". Implementation took the first option; this doc is about switching to the second.

None of this changes what the endpoints do — this is a same-behavior reorganization, plus one deliberate URL change (below).

## Decision

Delete `domains/ai-internal/`. Everything it did becomes part of `domains/ai-suggestions/`. The public/machine distinction is expressed by **file naming + middleware**, not by a second domain:

```
domains/ai-suggestions/
  ai-suggestions.route.ts            # unchanged: GET /ai-suggestions, POST .../queue-next, POST .../usage — authenticateUser
  ai-suggestions.internal.route.ts   # NEW — replaces ai-internal.route.ts:
                                      #   POST /ai-suggestions/internal/context   — requireServiceAuth
                                      #   POST /ai-suggestions/internal/results   — requireServiceAuth
  ai-suggestions.service.ts          # + getSuggestionContext(), saveAiSuggestions() added as new exports
  ai-suggestions.repository.ts       # + getSuggestionContextData(), upsertAiSuggestions() merged in — single owner of ai_suggestions reads+writes
  ai-suggestions.constants.ts        # NEW — renamed from ai-internal.constants.ts (FTS language map, book-code grouping)
  ai-suggestions.types.ts            # + SuggestionContextRequest/Response, AiSuggestionItem, UpsertAiSuggestionsRequest schemas merged in
  ai-suggestions.policy.ts           # unchanged
  ai-suggestions.auth.middleware.ts  # unchanged
  ai-suggestions.repository.test.ts  # extend with context-retrieval + upsert coverage (currently untested)
  ai-suggestions.route.test.ts       # extend, or add a sibling *.internal.route.test.ts
```

Only **one** new file (`ai-suggestions.internal.route.ts`). Service/repository/types layers don't need an `.internal.` split — they're plain business logic and don't care who's calling them. `chapter-assignments.repository.ts` is already 471 lines in this codebase as a single file, so the merged ~470-line `ai-suggestions.repository.ts` (227 + 246) isn't out of line with existing precedent; no need to invent a repository-splitting convention that doesn't exist elsewhere.

### Why not keep two files but same directory?

Because the actual reason `ai-internal` exists is auth + OpenAPI visibility, both of which are already expressible per-route:

- `requireServiceAuth` (generic, already in `src/middlewares/`) gates `ai-suggestions.internal.route.ts` instead of `authenticateUser`.
- Registering with raw `server.post(...)` instead of `createRoute()`/`server.openapi(...)` keeps a route out of the public OpenAPI doc. I confirmed this in `src/lib/configure-open-api.ts` — `app.doc('/doc', ...)` only walks `app.openAPIRegistry`, which `server.openapi()` populates and raw `server.post()` never touches. This works identically regardless of which domain folder the route file lives in, so nothing about the OpenAPI-hiding trick is lost by merging domains.

## URL changes (breaking — coordinate with fluent-ai)

| Old (current)                     | New                                  |
| ---------------------------------- | ------------------------------------- |
| `POST /internal/suggestion-context` | `POST /ai-suggestions/internal/context` |
| `POST /internal/ai-suggestions`     | `POST /ai-suggestions/internal/results` |

Renamed `suggestion-context` → `context` and `ai-suggestions` → `results` under the new prefix because repeating "ai-suggestions" in the path (`/ai-suggestions/internal/ai-suggestions`) was redundant once the resource is already the parent segment; `results` also reads more clearly as "AI is pushing its results back."

This is a genuine wire-contract change, unlike the rest of this doc. It requires an accompanying change in `fluent-ai`.

## Impact on fluent-ai

`src/app/worker/suggestion_processor.py::process_job` hardcodes both paths:

```python
context_resp = await client.post(
    f"{api_base_url}/internal/suggestion-context",   # → f"{api_base_url}/ai-suggestions/internal/context"
    ...
)
...
save_resp = await client.post(
    f"{api_base_url}/internal/ai-suggestions",       # → f"{api_base_url}/ai-suggestions/internal/results"
    ...
)
```

No payload/response shape changes — only the two URL strings. Nothing else in `fluent-ai` references these paths (`api_base_url` and `api_service_key` in `config.py` are unaffected).

## Implementation checklist (fluent-api)

1. Add `getSuggestionContextData` and `upsertAiSuggestions` to `ai-suggestions.repository.ts` (moved from `ai-internal.repository.ts`, unchanged logic) — this becomes the single writer of `ai_suggestions`.
   - While moving, resolve the existing dead-code duplication: `getSuggestionContextData` inlines the same source-verse query that the separately-exported (and unused) `getSourceVerses` already implements. Either delete `getSourceVerses` or have `getSuggestionContextData` call it — don't carry both forms over.
   - Replace `throw new Error('Project languages not found')` with `return err(ErrorCode.PROJECT_UNIT_NOT_FOUND)` (code already exists, already maps to 404 in `ErrorHttpStatus`) so this function matches the `Result<T>` convention like the rest of the domain instead of throwing.
2. Move `getFtsConfig` / `getContextBookCodes` and their supporting maps from `ai-internal.constants.ts` into a new `ai-suggestions.constants.ts`.
3. Add `getSuggestionContext()` and `saveAiSuggestions()` to `ai-suggestions.service.ts`, returning `Result<T>` and calling the repository functions from step 1.
4. Merge `suggestionContextRequestSchema`, `aiSuggestionItemSchema`, `upsertAiSuggestionsRequestSchema`, and the related response/interface types into `ai-suggestions.types.ts`.
5. Create `ai-suggestions.internal.route.ts`:
   - `POST /ai-suggestions/internal/context` and `POST /ai-suggestions/internal/results`, both behind `requireServiceAuth`.
   - Keep the raw `server.post(...)` registration style (not `createRoute`) to stay out of the public OpenAPI doc — carry over the explanatory comment from the old file.
   - Replace the manual `try/catch` + `error.name === 'ZodError'` handling with the `Result<T>` + `getHttpStatus` pattern used in `ai-suggestions.route.ts`.
6. Delete `src/domains/ai-internal/` entirely.
7. Update `src/app.ts`: replace
   ```ts
   import '@/domains/ai-internal/ai-internal.route';
   ```
   with
   ```ts
   import '@/domains/ai-suggestions/ai-suggestions.internal.route';
   ```
   (keep the existing `import '@/domains/ai-suggestions/ai-suggestions.route';` line as-is).
8. Tests: add coverage for the internal route (currently zero) and the moved repository functions, following the existing patterns in `ai-suggestions.route.test.ts` / `ai-suggestions.repository.test.ts`.

## Rollout

Nothing here is deployed yet — `draft/ai-suggestions` isn't merged to `main` in either repo — so the simplest path is an **atomic cutover**: land the fluent-api route-rename and the fluent-ai two-line URL update in the same coordinated deploy.

## Non-goals

- No change to the outbound trigger path (`POST /suggestions`, pg-boss, `ai-trigger.worker.ts`) — that's a different leg of the flow and already goes through `fluent-ai`'s own versioned `api/v1/endpoints/suggestions.py`.
- No change to `GET /ai-suggestions` / `POST /ai-suggestions/queue-next` / `POST /ai-suggestions/usage` request/response shapes.
- No change to the `ai_suggestions` / `ai_suggestion_usage_log` table schemas.
