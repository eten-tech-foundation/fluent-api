# AI-Tools Integration on fluent-api — Architecture Review Summary

> **Status update (2026-06-04) — implemented and verified live end-to-end.** This
> summary captures the pre-merge review framing; the integration has since been built on
> branch `jel-word-check` and exercised against a from-scratch fluent-platform stack
> (fluent-web → fluent-api → fluent-ai), with the smoke check passing host- and
> in-container. The file-by-file record and the verified-live notes live in
> [`ai-tools-integration-status.md`](ai-tools-integration-status.md). One implementation
> detail postdates this summary: the fluent-ai path prefix is configurable via
> `FLUENT_AI_API_PREFIX` (default empty, matching the live build that serves at the root)
> — see [`ai-tools-integration-suggestion.md`](ai-tools-integration-suggestion.md) §7.2.
> The paired fluent-platform compose change is broader than the single env override noted
> below (it also pins `MIGRATIONS_DATABASE_URL`, sets `UV_CACHE_DIR`, and mounts the
> smoke script) — see status doc §3.2.

**Purpose:** Reviewer orientation for the proposed AI-tools integration. This summary is intended to stand on its own; if more detail is wanted, the long-form proposal is split across two sibling files — [`ai-tools-integration-suggestion.md`](ai-tools-integration-suggestion.md) (**Part 1**: contract & design, §1–§10) and [`ai-tools-integration-operations.md`](ai-tools-integration-operations.md) (**Part 2**: operations, forward compatibility, testing, §11–§15). A file-by-file account of what is already implemented in the tree versus what remains lives in [`ai-tools-integration-status.md`](ai-tools-integration-status.md). Ships as a coordinated pair of PRs — fluent-api (the bulk) plus a small fluent-platform PR adding one compose env-var override (per **D12**).

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

## Reviewer outcome

Reviewed and **approved** by kaseywright on 2026-06-02 ([PR #173](https://github.com/eten-tech-foundation/fluent-api/pull/173)). All four questions above were confirmed as proposed; the supporting detail and the two "please document" follow-ups now live in the long-form proposal:

1. **URL layout** — confirmed ("this URL layout works well"). [Comment.](https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343625894)
2. **Permission alias** — confirmed; decision documented for future reference in [`ai-tools-integration-suggestion.md`](ai-tools-integration-suggestion.md) §9.3 / **D10**. [Comment.](https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343633722)
3. **Envelope pass-through** — confirmed, conditioned on the web-client response following fluent-api's standard response format; see §8.2 / **D9**. [Comment.](https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343642943)
4. **No request enrichment** — forwarding verbatim confirmed; the intentional snake_case naming divergence is documented (with an in-code-comment guardrail) in §8.1 / **D8**. [Comment.](https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343677813)
