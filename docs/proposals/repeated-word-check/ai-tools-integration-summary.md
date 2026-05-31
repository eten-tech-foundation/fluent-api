# AI-Tools Integration on fluent-api — Architecture Review Summary

**Purpose:** Reviewer orientation for the proposed AI-tools integration. Long-form proposal lives in the sibling [`ai-tools-integration-suggestion.md`](ai-tools-integration-suggestion.md) if more detail is wanted; this summary is intended to stand on its own. Ships as a coordinated pair of PRs — fluent-api (the bulk) plus a small fluent-platform PR adding one compose env-var override (per **D12**).

## What's being proposed

Expose fluent-ai's Greek-Room _Repeated Words_ check through fluent-api as the first AI-tool endpoint, using a pattern designed to absorb every future AI tool (LLM drafting, embeddings, other Greek-Room checks) with a five-line per-tool wrapper.

## Core architectural decisions for review

1. **New top-level namespace `POST /ai/tools/greek-room/repeated-words`** — introduces `/ai/` as fluent-api's first service-family prefix, signaling "network-bound, possibly async." Per-tool URL preserves OpenAPI type-safety; a generic `/dispatch` endpoint was rejected for the same reasons fluent-ai rejected it. Leaves room for a future `GET /ai/tools/jobs/{job_id}` polling endpoint without colliding with the existing pg-boss `/jobs/{id}` route under `/usfm`.

2. **One shared utility, `callFluentAi<TReq, TResult>(toolPath, body, schema)`** — a higher-order async wrapper at `lib/services/fluent-ai/`, modeled on the existing Mailgun service and `withDatabaseRetry` patterns. Each tool gets a typed wrapper in `domains/ai-tools/`; adding a new tool is two files, three to ten lines plus schemas.

3. **Envelope pass-through** — fluent-api forwards `ToolJobResponse[T]` from fluent-ai to fluent-web verbatim (`status`, `job_id`, `result`, `error`, timestamps). Same hook code handles sync `completed` today and `queued → polled → completed` tomorrow. Polling lives in the browser via TanStack Query's `refetchInterval`, not on fluent-api.

4. **No request enrichment** — body forwarded to fluent-ai verbatim, including `lang_code`, `project_id`, `verses[]`. Avoids coupling fluent-api to fluent-ai's input schema.

5. **Reuse existing fluent-api substrate** — BetterAuth session + `requirePermission` for caller auth; a single shared `FLUENT_AI_KEY` (env-driven) for the fluent-api → fluent-ai hop; `Result<T>` + `getHttpStatus` for errors (two new codes: `AI_SERVICE_UNAVAILABLE` and `AI_TOOL_EXECUTION_FAILED`, both → 502); fluent-platform's existing compose network for service discovery (`http://ai:8200`).

## Explicitly out of scope (deferred)

Polling endpoint on either side, DB persistence of tool runs, frontend hooks and graphical UI, rate limits, request-size limits, MCP facade, SSE/WebSocket streaming, contract tests, per-user attribution, caching, transport retries.

## Areas where input would be most valuable

1. **URL layout** — is `POST /ai/tools/greek-room/repeated-words` the right shape, vs. `/checks/repeated-words` or nesting under `/chapter-assignments/{id}/`?
2. **Permission alias** — `PERMISSIONS.AI_TOOLS_USE` as a string-value alias of `CONTENT_UPDATE`, vs. a real new permission row with migration + seeding?
3. **Envelope pass-through** — return the full `ToolJobResponse` today, vs. unwrap `result` for the sync case and reshape later when polling lands?
4. **No request enrichment** — forward verbatim, vs. server-side lookup of `chapter_assignment_id` → verses, vs. a validation-only hybrid?
