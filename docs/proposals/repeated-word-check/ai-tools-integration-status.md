# AI-Tools Integration on fluent-api — Implementation Status

**Purpose:** A file-by-file account of what is already implemented in the fluent-api tree versus what remains to be done, so an agent or developer picking this work up can orient quickly without re-deriving it from the proposal. If you are new to this feature, **read this file first**, then the design in the companion docs.

**Companion documents:**

- [`ai-tools-integration-suggestion.md`](ai-tools-integration-suggestion.md) — **Part 1 of 2.** Contract & design (§1–§10).
- [`ai-tools-integration-operations.md`](ai-tools-integration-operations.md) — **Part 2 of 2.** Operations, forward compatibility, testing, future work (§11–§15), including the **§12.10 "wire up a running ecosystem" runbook**.
- [`ai-tools-integration-summary.md`](ai-tools-integration-summary.md) — short reviewer orientation.

**Branch:** `jel-word-check` (do **not** create a new branch; do **not** push).
**Implementation commit:** `b055f84` — _feat(ai-tools): add greek-room repeated-words endpoint + fluent-ai client_ (17 files, +1348/−26).

---

## 1. Status at a glance

| Area                                                              | Status          | Notes                                                                                      |
| ----------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| Endpoint `POST /ai/tools/greek-room/repeated-words`               | ✅ Implemented  | Route + service + types in `src/domains/ai-tools/`, registered on the app.                 |
| Shared client `callFluentAi`                                      | ✅ Implemented  | `src/lib/services/fluent-ai/`, modeled on Mailgun + `withDatabaseRetry`.                   |
| Env vars `FLUENT_AI_URL` / `FLUENT_AI_KEY`                        | ✅ Implemented  | Required (no defaults) in `src/env.ts`; documented in `.env.example`.                      |
| Permission alias `AI_TOOLS_USE`                                   | ✅ Implemented  | Alias of `content:update` in `src/lib/permissions.ts` (D10).                               |
| Error codes `AI_SERVICE_UNAVAILABLE` / `AI_TOOL_EXECUTION_FAILED` | ✅ Implemented  | Both → HTTP 502 in `src/lib/types.ts`.                                                     |
| Unit tests (`callFluentAi`)                                       | ✅ Implemented  | `fluent-ai.client.test.ts`.                                                                |
| Route tests                                                       | ✅ Implemented  | `ai-tools.route.test.ts`.                                                                  |
| Smoke script + npm alias                                          | ✅ Implemented  | `scripts/smoke-repeated-words.ts`, `npm run smoke:repeated-words`.                         |
| Documentation                                                     | ✅ Implemented  | This file + the split Part 1 / Part 2 proposal + summary.                                  |
| **Live end-to-end run** (fluent-api ↔ fluent-ai)                 | ⏳ **Not done** | Requires local wiring — see "What remains" below and the §12.10 runbook.                   |
| fluent-platform compose override                                  | ⏳ Not done     | **Separate paired PR** (D12). `FLUENT_AI_URL: http://ai:8200`. Not part of this repo's PR. |
| Polling endpoint / DB persistence / frontend / retries / caching  | ⛔ Out of scope | Deferred by design — see §2 / §14 of the proposal.                                         |

Legend: ✅ done · ⏳ remaining · ⛔ intentionally out of scope.

---

## 2. What is implemented (file-by-file, committed at `b055f84`)

### New domain — `src/domains/ai-tools/`

- **`ai-tools.route.ts`** — Declares `POST /ai/tools/greek-room/repeated-words` via `createRoute`, guarded by `authenticateUser` + `requirePermission(PERMISSIONS.AI_TOOLS_USE)`. On success returns the full `ToolJobResponse` envelope verbatim (D9): **200** for terminal statuses (`completed`/`failed`/`cancelled`) and **202** for non-terminal (`queued`/`running`). On error, uses fluent-api's standard `{ error, code, details }` shape via `getHttpStatus`.
- **`ai-tools.service.ts`** — `callRepeatedWords(req)`, the one-line typed wrapper that calls `callFluentAi('tools/greek-room/repeated-words', req, RepeatedWordsResultSchema)`. This is the per-tool pattern future tools copy.
- **`ai-tools.types.ts`** — `VerseInputSchema`, `RepeatedWordsRequestSchema`, `RepeatedWordsFindingSchema`, `RepeatedWordsSummarySchema`, `RepeatedWordsResultSchema`, `RepeatedWordsResponseSchema`, and inferred TS types. **Field names are snake_case** (`lang_code`, `snt_id`, `start_position`, …) — an intentional, contained exception (D8) carrying an in-code comment that links to §8.1 and review comment `#discussion_r3343677813`.

### New shared client — `src/lib/services/fluent-ai/`

- **`fluent-ai.client.ts`** — `callFluentAi<TReq, TResult>(toolPath, body, resultSchema, options?)`. POSTs to `${FLUENT_AI_URL}/api/v1/${toolPath}` with `X-API-Key`; default **30s** timeout (overridable via `options.timeoutMs` / `options.signal`); validates the `result` field against `resultSchema` only when `status === "completed"`; returns `Result<ToolJobResponse<TResult>>`. Maps transport/HTTP/parse failures → `AI_SERVICE_UNAVAILABLE`, and `failed`/`cancelled` envelopes → `AI_TOOL_EXECUTION_FAILED` (§10.2). Does **not** poll, cache, or retry (by design). The malformed-body branch returns the message `malformed response from fluent-ai (body was not valid JSON)`.
- **`fluent-ai.types.ts`** — `JobStatus` union, `ToolJobError`, and the generic `ToolJobResponse<TResult>` envelope. Carries the same snake_case in-code comment / D8 cross-reference as `ai-tools.types.ts`.

### Edits to existing files

- **`src/app.ts`** — Registers the ai-tools routes on the OpenAPIHono app, the same way existing domains are registered.
- **`src/env.ts`** — Adds `FLUENT_AI_URL` (URL) and `FLUENT_AI_KEY` (non-empty string) to the Zod env schema. Both **required, no defaults**; a missing/blank value fails validation at boot.
- **`src/lib/permissions.ts`** — Adds `PERMISSIONS.AI_TOOLS_USE = 'content:update'` (alias of `CONTENT_UPDATE`), with a comment linking to §9.3 / D10 and review comment `#discussion_r3343633722`.
- **`src/lib/types.ts`** — Adds `ErrorCode.AI_SERVICE_UNAVAILABLE` and `ErrorCode.AI_TOOL_EXECUTION_FAILED`, both mapped to HTTP **502** in `ErrorHttpStatus`.
- **`.env.example`** — Adds documented `FLUENT_AI_URL` and `FLUENT_AI_KEY` entries (standalone default `http://localhost:8200`, dev key `fai_dev_admin`).
- **`.env.test`** — Adds test values for the two vars so the suite boots.
- **`package.json`** — Adds the `smoke:repeated-words` script.

### Tests & tooling

- **`src/lib/services/fluent-ai/fluent-ai.client.test.ts`** — Unit tests for `callFluentAi` with `fetch` stubbed: completed/queued happy paths, failed/cancelled → `AI_TOOL_EXECUTION_FAILED`, 4xx/5xx/network/parse/schema failures → `AI_SERVICE_UNAVAILABLE`, timeout, abort signal, and request-shape assertions (header, URL).
- **`src/domains/ai-tools/ai-tools.route.test.ts`** — Route tests: 401 unauthenticated, 403 missing permission, 400 invalid body, 200 completed pass-through, 202 queued pass-through, 502 on failed/transport error, and a "no enrichment" assertion that the body is forwarded verbatim.
- **`scripts/smoke-repeated-words.ts`** — Host-runnable probe against a live fluent-api + fluent-ai pair. CLI flags `--url`, `--token`, `--cookie`, `--timeout`, `--raw`; reads `FLUENT_API_URL` / `FLUENT_API_TOKEN` from env; default base URL `http://localhost:9999`. Posts the canned 3-verse corpus and sanity-checks the envelope (see §13.3).

---

## 3. What remains (and who owns it)

### 3.1 Live end-to-end verification (this repo, but local-only)

The code is complete and the automated suite passes, but **no live fluent-api ↔ fluent-ai round-trip has been exercised** as part of this work. Doing so needs machine-specific wiring that is intentionally _not_ committed:

1. Add `FLUENT_AI_URL` + `FLUENT_AI_KEY` to the git-ignored `fluent-api/.env`.
2. Bring up the stack (ecosystem mode) or run fluent-ai alongside standalone fluent-api.
3. Sign in via BetterAuth to obtain a bearer token.
4. Run `npm run smoke:repeated-words -- --url <base> --token <token>`.

The full step-by-step procedure (including the BetterAuth `set-auth-token` capture and the expected sanity-check output) is the **§12.10 runbook** in [`ai-tools-integration-operations.md`](ai-tools-integration-operations.md). Nothing in that runbook should be committed to this repo — the `.env` values are per-machine secrets.

### 3.2 fluent-platform compose override (separate paired PR — D12)

[`fluent-platform/compose.yaml`](../../../../fluent-platform/compose.yaml) needs `FLUENT_AI_URL: http://ai:8200` added to the `api` service's `environment:` block so ecosystem mode resolves fluent-ai by service name. **`FLUENT_AI_KEY` is deliberately not overridden there** — it stays a shared secret sourced from `fluent-api/.env` (§12.4). This is a small, logic-free PR that ships alongside the fluent-api PR. **Do not touch fluent-platform from this task.**

### 3.3 Out of scope (do not build — §2 / §14)

Polling endpoint (`GET /ai/tools/jobs/{job_id}`), DB persistence of tool runs, frontend hooks / editor squiggles, transport retries, response caching, rate limits, MCP facade. All deferred by design; the `callFluentAi` / `ToolJobResponse` shapes are forward-compatible with them.

---

## 4. Verification

Run from `fluent-api/`:

```bash
npm run typecheck
npm run format:check
npm run lint
npm test
```

The automated suite does **not** include the smoke script (it needs a live stack). See §13 of the proposal for the full testing strategy.
