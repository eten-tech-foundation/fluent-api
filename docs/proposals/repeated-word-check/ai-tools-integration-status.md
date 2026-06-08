# AI-Tools Integration on fluent-api — Implementation Status

**Purpose:** A file-by-file account of what is already implemented in the fluent-api tree versus what remains to be done, so an agent or developer picking this work up can orient quickly without re-deriving it from the proposal. If you are new to this feature, **read this file first**, then the design in the companion docs.

**Companion documents:**

- [`ai-tools-integration-suggestion.md`](ai-tools-integration-suggestion.md) — **Part 1 of 2.** Contract & design (§1–§10).
- [`ai-tools-integration-operations.md`](ai-tools-integration-operations.md) — **Part 2 of 2.** Operations, forward compatibility, testing, future work (§11–§15), including the **§12.10 "wire up a running ecosystem" runbook**.
- [`ai-tools-integration-summary.md`](ai-tools-integration-summary.md) — short reviewer orientation.

**Branch:** `jel-word-check` (do **not** create a new branch; do **not** push).
**Implementation commit:** `b055f84` — _feat(ai-tools): add greek-room repeated-words endpoint + fluent-ai client_ (17 files, +1348/−26).

> **Update (2026-06-04) — verified live end-to-end.** The integration has now been
> exercised against a from-scratch fluent-platform stack and passes both on the host
> and from inside the `api` container (10/10 smoke-test checks, HTTP 200). Two things
> changed while wiring it up, both reflected in the sections below:
>
> 1. **Configurable fluent-ai path prefix.** The live fluent-ai build mounts its
>    routers at the **root** (`POST /tools/greek-room/repeated-words`), not under
>    `/api/v1` as the schemas' directory layout implied — the previously hardcoded
>    `/api/v1/` in `callFluentAi` produced a 404 → `502 AI_SERVICE_UNAVAILABLE`. The
>    prefix is now a configurable env var, **`FLUENT_AI_API_PREFIX`**, defaulting to
>    empty to match the live build. When fluent-ai adopts versioned routing it is a
>    pure env flip (`FLUENT_AI_API_PREFIX=/api/v1`) with no code change.
> 2. **fluent-platform compose needs more than the URL override** to bring the `ai`
>    container up from a clean slate (Alembic DB-URL and a uv-cache fix) — see §3.2.

---

## 1. Status at a glance

| Area                                                              | Status          | Notes                                                                                                            |
| ----------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| Endpoint `POST /ai/tools/greek-room/repeated-words`               | ✅ Implemented  | Route + service + types in `src/domains/ai-tools/`, registered on the app.                                       |
| Shared client `callFluentAi`                                      | ✅ Implemented  | `src/lib/services/fluent-ai/`, modeled on Mailgun + `withDatabaseRetry`.                                         |
| Env vars `FLUENT_AI_URL` / `FLUENT_AI_KEY`                        | ✅ Implemented  | Required (no defaults) in `src/env.ts`; documented in `.env.example`.                                            |
| Env var `FLUENT_AI_API_PREFIX`                                    | ✅ Implemented  | Optional; defaults to empty (live build serves at root). Set `/api/v1` if/when fluent-ai versions its routes.    |
| Permission alias `AI_TOOLS_USE`                                   | ✅ Implemented  | Alias of `content:update` in `src/lib/permissions.ts` (D10).                                                     |
| Error codes `AI_SERVICE_UNAVAILABLE` / `AI_TOOL_EXECUTION_FAILED` | ✅ Implemented  | Both → HTTP 502 in `src/lib/types.ts`.                                                                           |
| Unit tests (`callFluentAi`)                                       | ✅ Implemented  | `fluent-ai.client.test.ts` (incl. `FLUENT_AI_API_PREFIX` cases).                                                 |
| Route tests                                                       | ✅ Implemented  | `ai-tools.route.test.ts`.                                                                                        |
| Smoke script + npm alias                                          | ✅ Implemented  | `scripts/smoke-repeated-words.ts`, `npm run smoke:repeated-words` (auto sign-in + PASS/FAIL banner).             |
| Documentation                                                     | ✅ Implemented  | This file + the split Part 1 / Part 2 proposal + summary.                                                        |
| **Live end-to-end run** (fluent-api ↔ fluent-ai)                 | ✅ **Done**     | Verified 2026-06-04 against a from-scratch platform stack — 10/10 on the host **and** in-container. See §3.1.    |
| fluent-platform compose override                                  | ✅ Applied      | Applied locally (URL override + two clean-slate fixes). Still ships as a **separate paired PR** (D12); see §3.2. |
| Polling endpoint / DB persistence / frontend / retries / caching  | ⛔ Out of scope | Deferred by design — see §2 / §14 of the proposal.                                                               |

Legend: ✅ done · ⏳ remaining · ⛔ intentionally out of scope.

---

## 2. What is implemented (file-by-file, committed at `b055f84`)

### New domain — `src/domains/ai-tools/`

- **`ai-tools.route.ts`** — Declares `POST /ai/tools/greek-room/repeated-words` via `createRoute`, guarded by `authenticateUser` + `requirePermission(PERMISSIONS.AI_TOOLS_USE)`. On success returns the full `ToolJobResponse` envelope verbatim (D9): **200** for terminal statuses (`completed`/`failed`/`cancelled`) and **202** for non-terminal (`queued`/`running`). On error, uses fluent-api's standard `{ error, code, details }` shape via `getHttpStatus`.
- **`ai-tools.service.ts`** — `callRepeatedWords(req)`, the one-line typed wrapper that calls `callFluentAi('tools/greek-room/repeated-words', req, RepeatedWordsResultSchema)`. This is the per-tool pattern future tools copy.
- **`ai-tools.types.ts`** — `VerseInputSchema`, `RepeatedWordsRequestSchema`, `RepeatedWordsFindingSchema`, `RepeatedWordsSummarySchema`, `RepeatedWordsResultSchema`, `RepeatedWordsResponseSchema`, and inferred TS types. **Field names are snake_case** (`lang_code`, `snt_id`, `start_position`, …) — an intentional, contained exception (D8) carrying an in-code comment that links to §8.1 and review comment `#discussion_r3343677813`.

### New shared client — `src/lib/services/fluent-ai/`

- **`fluent-ai.client.ts`** — `callFluentAi<TReq, TResult>(toolPath, body, resultSchema, options?)`. Builds the target URL via a `buildToolUrl(toolPath)` helper that joins `FLUENT_AI_URL` + the optional `FLUENT_AI_API_PREFIX` + `toolPath` (normalizing slashes), then POSTs to it with `X-API-Key`. With the default empty prefix the URL is `${FLUENT_AI_URL}/${toolPath}` (matching the live fluent-ai build, which serves at the root); setting `FLUENT_AI_API_PREFIX=/api/v1` produces `${FLUENT_AI_URL}/api/v1/${toolPath}`. Default **30s** timeout (overridable via `options.timeoutMs` / `options.signal`); validates the `result` field against `resultSchema` only when `status === "completed"`; returns `Result<ToolJobResponse<TResult>>`. Maps transport/HTTP/parse failures → `AI_SERVICE_UNAVAILABLE`, and `failed`/`cancelled` envelopes → `AI_TOOL_EXECUTION_FAILED` (§10.2). Does **not** poll, cache, or retry (by design). The malformed-body branch returns the message `malformed response from fluent-ai (body was not valid JSON)`.
- **`fluent-ai.types.ts`** — `JobStatus` union, `ToolJobError`, and the generic `ToolJobResponse<TResult>` envelope. Carries the same snake_case in-code comment / D8 cross-reference as `ai-tools.types.ts`.

### Edits to existing files

- **`src/app.ts`** — Registers the ai-tools routes on the OpenAPIHono app, the same way existing domains are registered.
- **`src/env.ts`** — Adds `FLUENT_AI_URL` (URL) and `FLUENT_AI_KEY` (non-empty string) to the Zod env schema. Both **required, no defaults**; a missing/blank value fails validation at boot. Also adds `FLUENT_AI_API_PREFIX` (string, **optional**, defaults to `''`) — the path segment between `FLUENT_AI_URL` and the tool path; empty matches the live fluent-ai build (routes served at root), `/api/v1` for a future versioned deployment.
- **`src/lib/permissions.ts`** — Adds `PERMISSIONS.AI_TOOLS_USE = 'content:update'` (alias of `CONTENT_UPDATE`), with a comment linking to §9.3 / D10 and review comment `#discussion_r3343633722`.
- **`src/lib/types.ts`** — Adds `ErrorCode.AI_SERVICE_UNAVAILABLE` and `ErrorCode.AI_TOOL_EXECUTION_FAILED`, both mapped to HTTP **502** in `ErrorHttpStatus`.
- **`.env.example`** — Adds documented `FLUENT_AI_URL` and `FLUENT_AI_KEY` entries (standalone default `http://localhost:8200`, dev key `fai_dev_admin`), plus `FLUENT_AI_API_PREFIX=` (empty, with a note that it can be set to `/api/v1` once fluent-ai versions its routes).
- **`.env.test`** — Adds test values for the two vars so the suite boots.
- **`package.json`** — Adds the `smoke:repeated-words` script.

### Tests & tooling

- **`src/lib/services/fluent-ai/fluent-ai.client.test.ts`** — Unit tests for `callFluentAi` with `fetch` stubbed: completed/queued happy paths, failed/cancelled → `AI_TOOL_EXECUTION_FAILED`, 4xx/5xx/network/parse/schema failures → `AI_SERVICE_UNAVAILABLE`, timeout, abort signal, and request-shape assertions (header, URL).
- **`src/domains/ai-tools/ai-tools.route.test.ts`** — Route tests: 401 unauthenticated, 403 missing permission, 400 invalid body, 200 completed pass-through, 202 queued pass-through, 502 on failed/transport error, and a "no enrichment" assertion that the body is forwarded verbatim.
- **`scripts/smoke-repeated-words.ts`** — Host-runnable probe against a live fluent-api + fluent-ai pair. CLI flags `--url`, `--token`, `--cookie`, `--timeout`, `--raw`, plus **auto sign-in** support: when no credential is supplied it signs in via BetterAuth (`--signin-email` / `--signin-password`, default `t@fluent.local`) and captures the `set-auth-token` bearer. Sends a trusted `Origin` header (`--origin`, env `FLUENT_API_ORIGIN` / `FRONTEND_URL`, default `http://localhost:5173`) so the sign-in isn't rejected with `MISSING_OR_NULL_ORIGIN` / `INVALID_ORIGIN`. Reads `FLUENT_API_URL` / `FLUENT_API_TOKEN` from env; default base URL `http://localhost:9999`. Posts the canned 3-verse corpus, sanity-checks the envelope (see §13.3), and ends with an unmissable **PASS/FAIL banner + check tally**. On a missing dev user it prints the exact `docker compose exec … organizations.ts` / `dev-users.ts` seed commands; on an origin mismatch it prints a targeted hint.

---

## 3. What remains (and who owns it)

### 3.1 Live end-to-end verification — ✅ done (2026-06-04)

The live fluent-api ↔ fluent-ai round-trip **has now been exercised** against a
from-scratch fluent-platform ecosystem stack (clean containers + clean volumes,
`./fluent.sh up`), with `db`, `api`, and `ai` all reaching healthy on a from-scratch
init (no manual `ALTER USER`). The smoke test passed **10/10** twice:

- **From the host:** `npm run smoke:repeated-words` (auto sign-in, default base URL
  `http://localhost:9999`) → HTTP 200, envelope `completed`, tool
  `greek_room.repeated_words`, exactly two findings (one legitimate, one suspicious),
  `verse_count === 3`, `total_findings === findings.length`.
- **From inside the `api` container:** the same script via the platform compose
  scripts bind mount, `--url http://api:9999` → identical 10/10 result.

The automated suite is green alongside it: `typecheck`, `lint`, and the full **76/76**
vitest run (including the new `FLUENT_AI_API_PREFIX` client cases).

Reproducing this still needs machine-specific wiring that is intentionally _not_
committed to this repo (per-machine secrets):

1. Add `FLUENT_AI_URL`, `FLUENT_AI_KEY` (and optionally `FLUENT_AI_API_PREFIX`) to the
   git-ignored `fluent-api/.env`.
2. Bring up the stack (ecosystem mode `./fluent.sh up`) or run fluent-ai alongside
   standalone fluent-api.
3. Seed the org + dev users so a sign-in account exists (the entrypoint auto-runs
   migrate/roles/rbac but **not** account provisioning):
   `docker compose exec api npx tsx src/db/seeds/organizations.ts` then
   `… src/db/seeds/dev-users.ts` (org before users). The smoke script prints these
   exact commands if the dev user is missing.
4. Run `npm run smoke:repeated-words` (auto sign-in) — or pass `--token` / `--cookie`
   explicitly.

The full step-by-step procedure (including the BetterAuth `set-auth-token` capture and
the expected sanity-check output) is the **§12.10 runbook** in
[`ai-tools-integration-operations.md`](ai-tools-integration-operations.md). Nothing in
that runbook should be committed to this repo — the `.env` values are per-machine
secrets.

### 3.2 fluent-platform compose changes (applied locally; separate paired PR — D12)

The required fluent-platform changes have been **applied to the local working tree** and
exercised by the §3.1 from-scratch bring-up. They still ship as a **separate paired PR**
against fluent-platform (D12) — a fork remote needs to be created before pushing. The
`api` service's `environment:` block in
[`fluent-platform/compose.yaml`](../../../../fluent-platform/compose.yaml) gets
`FLUENT_AI_URL: http://ai:8200` (so ecosystem mode resolves fluent-ai by service name),
plus a read-only bind mount of `fluent-api/scripts` so the smoke script is runnable
in-container. **`FLUENT_AI_KEY` is deliberately not overridden there** — it stays a
shared secret sourced from `fluent-api/.env` (§12.4).

Two additional clean-slate fixes to the **`ai`** service were needed so the container
comes up from scratch (both upstream-platform issues surfaced while validating
reproducibility, not specific to this feature):

- **Alembic DB URL:** `MIGRATIONS_DATABASE_URL=postgresql+asyncpg://migrations:postgres@db:5432/fluent`
  — the migrations role's password was drifting (`password` vs `postgres`), crashing the
  `ai` container's migration step.
- **uv cache off the noexec mount:** `UV_CACHE_DIR=/tmp/.uv-cache` with the `/tmp` tmpfs
  bumped to `size=256m`.

These belong in the same paired fluent-platform PR. **Do not push fluent-platform from
this task** until the fork remote exists.

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
