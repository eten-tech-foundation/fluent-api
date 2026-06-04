# AI-Tools Integration on fluent-api — Proposal (Part 2 of 2: Operations & Forward Compatibility)

**Status:** Reviewed and **approved** (kaseywright, PR #173, 2026-06-02). Implemented on branch `jel-word-check` — see the implementation-status doc below for what currently exists in the tree.
**Scope:** Extend fluent-api to expose AI tools implemented by fluent-ai, starting with Greek-Room's _Repeated Words_ check. The exposed pattern is meant to absorb every future AI tool (LLM drafting, embeddings, fine-tuning, other Greek-Room checks) without renegotiating the contract.

**This document is Part 2 of 2.** It covers operations and forward compatibility: the job-queue protocol, service discovery / Docker / environment wiring (including the step-by-step "wire up a running ecosystem" checklist), the testing strategy, future work, and the resolved reviewer Q&A (§11–§15).

**Companion documents:**

- [`ai-tools-integration-suggestion.md`](ai-tools-integration-suggestion.md) — **Part 1 of 2.** Contract and design: background, scope, decisions, the URL, the file layout, the `callFluentAi` utility, request/response shapes, auth, and error translation (§1–§10). **Read Part 1 first.**
- [`ai-tools-integration-status.md`](ai-tools-integration-status.md) — **Implementation status.** What is already implemented in the tree (file-by-file) versus what remains to be done. Start here if you are an agent or developer picking this work up.
- [`ai-tools-integration-summary.md`](ai-tools-integration-summary.md) — short reviewer orientation.

**Predecessors on the fluent-ai side:** [`fluent-ai/greek-room-integration-summary.md`](../../../../fluent-ai/greek-room-integration-summary.md), [`fluent-ai/greek-room-integration-suggestion.md`](../../../../fluent-ai/greek-room-integration-suggestion.md), [`fluent-ai/greek-room-integration-decisions.md`](../../../../fluent-ai/greek-room-integration-decisions.md).

> **Note on document split.** This proposal was split into two files at the §10/§11 boundary so each stays under the repo's markdown line-count lint limit. Sections are numbered continuously across both files (Part 1 ends at §10; Part 2 begins at §11), so all internal "see §N" references remain valid across the pair. Relative paths in this document (e.g. `../src/...`, `../../fluent-platform/...`) assume the standard side-by-side repo layout that fluent-platform's setup script produces.

---

## 11. The job-queue protocol — forward compatibility

This section describes what this PR sets up but does **not** exercise: the asynchronous job-queue contract that fluent-ai's `ToolJobResponse` envelope already accommodates. Today every call is synchronous (`status: "completed"`); the machinery below is the agreed-upon shape for when a slow tool eventually needs it. Nothing here ships as code in this PR — it is documented so the envelope pass-through (D9) and the `/ai/` URL namespace (D2) can be understood as deliberately forward-compatible choices.

### 11.1 The contract today vs. tomorrow

**Today** every response from fluent-ai is synchronous with `status: "completed"`. fluent-api hands the envelope to fluent-web as a 200 response. No polling occurs.

**Tomorrow**, when fluent-ai introduces a slow tool, it can return `202 Accepted` with `status: "queued"` and a real `job_id` that exists in fluent-ai's job table. The protocol fluent-ai will (eventually) expose is the existing fluent-ai decision **D3** envelope plus a new polling endpoint:

```
GET /api/v1/tools/jobs/{job_id}
→ ToolJobResponse<TResult> with current status and (if completed) result
```

Returns 200 in all states (queued/running/completed/failed/cancelled). The HTTP status is _not_ used to communicate terminal vs. non-terminal — only the envelope's `status` field is.

### 11.2 fluent-api's pass-through polling endpoint (future)

When fluent-ai adds the polling endpoint, fluent-api adds:

```
GET /ai/tools/jobs/{job_id}
→ Pass-through of fluent-ai's response, with the same auth (BetterAuth session + AI_TOOLS_USE permission)
```

Implementation will be a second helper alongside `callFluentAi`:

```ts
// future, not in this PR
export async function pollToolJob<TResult>(
  jobId: string,
  resultSchema: z.ZodType<TResult>
): Promise<Result<ToolJobResponse<TResult>>>;
```

### 11.3 Why polling lives in the browser, not in fluent-api

Per **D3**. The detailed reasoning, repeated for completeness:

- **Decouples slow tools from fluent-api's request budget.** A 5-minute tool does not hold a browser-to-fluent-api socket open for 5 minutes through whatever proxies, load balancers, or middle boxes sit between them.
- **Matches the editor UX shape.** When the eventual squiggle-on-typing UX is built, the browser already has its own state machine for "user has typed, debounce, kick off check, show pending indicator, show squiggles when result arrives." Putting polling on the server adds nothing to that loop.
- **TanStack Query has the right primitives.** `refetchInterval` accepts a function that inspects the current data and returns `false` to stop polling — i.e., literally `(data) => isTerminal(data.status) ? false : 1500`. No custom polling library needed.
- **Aligns with the existing fluent-web pattern.** Every existing fluent-web API hook calls `fetch` directly; there is no centralized server-state abstraction beyond TanStack itself. Adding server-side polling would be the foreign element.

### 11.4 What the frontend hook will look like (out of scope, sketched)

This is _not_ part of this PR, but is sketched here so reviewers can see that the backend contract is consumable.

```ts
// fluent-web/src/lib/api/useToolJob.ts (future)

import { useQuery } from '@tanstack/react-query';

import type { ToolJobResponse } from './tool-job-types';

const TERMINAL: Set<ToolJobResponse<unknown>['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export function useToolJob<TResult>(
  jobId: string | null,
  opts?: { pollIntervalMs?: number; enabled?: boolean }
) {
  return useQuery<ToolJobResponse<TResult>>({
    queryKey: ['ai-tools', 'jobs', jobId],
    queryFn: () =>
      fetch(`${config.api.url}/ai/tools/jobs/${jobId}`, { credentials: 'include' }).then((r) =>
        r.json()
      ),
    enabled: !!jobId && (opts?.enabled ?? true),
    refetchInterval: (q) =>
      q.state.data && TERMINAL.has(q.state.data.status) ? false : (opts?.pollIntervalMs ?? 1500),
  });
}
```

```ts
// fluent-web/src/features/checks/hooks/useRepeatedWords.ts (future)

export function useRepeatedWords() {
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  const kickoff = useMutation({
    mutationFn: (req: RepeatedWordsRequest) =>
      fetch(`${config.api.url}/ai/tools/greek-room/repeated-words`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      }).then((r) => r.json() as Promise<ToolJobResponse<RepeatedWordsResult>>),
    onSuccess: (envelope) => {
      if (envelope.status === 'queued' || envelope.status === 'running') {
        setPendingJobId(envelope.job_id);
      }
    },
  });

  const polled = useToolJob<RepeatedWordsResult>(pendingJobId);

  // Today, only kickoff.data is ever populated. Tomorrow, polled.data takes over.
  const envelope = polled.data ?? (kickoff.data?.status === 'completed' ? kickoff.data : null);

  return { kickoff, envelope };
}
```

### 11.5 No frontend code in this PR

Per the user's instruction during the spec discussion, frontend work is a separate session. The above sketches are appendix material so reviewers can confirm the backend contract is sufficient for the eventual frontend implementation.

---

## 12. Service discovery, environment, and Docker networking

The cross-repo orchestration substrate already exists as [`fluent-platform`](../../../../fluent-platform/README.md). Its [`compose.yaml`](../../../../fluent-platform/compose.yaml) brings up `db`, `api`, `worker`, `ai`, and `web` on a shared Docker/Podman network with service names usable as DNS, plus a shared PostgreSQL instance with role-based schema separation. This section describes how this PR plugs into that substrate and the small changes needed in fluent-api and fluent-platform.

### 12.1 The two runtime modes

Per [`fluent-platform/README.md`](../../../../fluent-platform/README.md), fluent-api runs in one of two modes:

- **Ecosystem mode** — started via `./fluent.sh up` from `fluent-platform/`. fluent-ai is also up, reachable at `http://ai:8200` on the internal network (service name `ai` from [`fluent-platform/compose.yaml`](../../../../fluent-platform/compose.yaml) line 82).
- **Standalone mode** — started via `./fapi.sh up` from `fluent-api/`. fluent-ai is _not_ running unless the dev started it separately. fluent-api needs to gracefully report unavailability rather than crash.

Both modes are first-class. The integration must work in both.

### 12.2 Env vars (fluent-api side)

Two new entries in [`fluent-api/src/env.ts`](../../../src/env.ts):

```ts
const envSchema = z.object({
  // ... existing ...
  FLUENT_AI_URL: z.string().url(), // ecosystem mode: http://ai:8200 — standalone: http://localhost:8200
  FLUENT_AI_KEY: z.string().min(1), // dev value: fai_dev_admin
});
```

Both are required (no defaults). Zod failure on boot prints a clear error and exits, matching how fluent-api already handles `DATABASE_URL`, `BETTER_AUTH_SECRET`, etc.

### 12.3 `fluent-api/.env.example` additions

```dotenv
# Fluent-AI integration
# Base URL of the fluent-ai service (no trailing slash, no /api/v1 suffix).
# - Ecosystem mode (via fluent-platform):                http://ai:8200
# - Standalone fluent-api against standalone fluent-ai:  http://localhost:8200
FLUENT_AI_URL=http://localhost:8200

# Shared API key for calling fluent-ai. Matches a row in fluent-ai's ai_api_keys table.
# Dev value seeded by fluent-ai: fai_dev_admin
FLUENT_AI_KEY=fai_dev_admin
```

The `.env.example` documents the standalone-mode default because that's the path a dev hits first when running `./fapi.sh up` and copying `.env.example` to `.env`. Ecosystem-mode overrides are applied at the platform-compose layer (§12.4).

### 12.4 Companion change in fluent-platform

[`fluent-platform/compose.yaml`](../../../../fluent-platform/compose.yaml) currently passes fluent-api's `.env` verbatim via `env_file: ${API_CONTEXT:-../fluent-api}/.env`. To make ecosystem mode work regardless of what the dev wrote in `fluent-api/.env`, the platform compose should explicitly override the URL for the `api` service:

```yaml
api:
  # ... existing ...
  env_file: ${API_CONTEXT:-../fluent-api}/.env
  environment:
    DATABASE_URL: postgres://postgres:postgres@db:5432/fluent
    EXPORTS_DIR: /app/exports
    # New entries:
    FLUENT_AI_URL: http://ai:8200
    # FLUENT_AI_KEY intentionally NOT overridden here — sourced from fluent-api/.env,
    # which must match fluent-ai's ai_api_keys seed (dev value: fai_dev_admin)
```

`FLUENT_AI_URL` is overridden because it's deployment-topology-dependent. `FLUENT_AI_KEY` is _not_ overridden because it's a shared secret — the same value belongs in `fluent-api/.env` (for the caller) and in fluent-ai's `ai_api_keys` table (which the dev seed already populates). Overriding only on one side would invite drift.

This is a small fluent-platform PR that should land alongside the fluent-api PR. Both repos ship together; the spec calls this out as a release-coordination item in §15.

### 12.5 Startup ordering

[`fluent-platform/compose.yaml`](../../../../fluent-platform/compose.yaml) line 110–112 currently has `ai` declaring `depends_on: api: service_healthy`. So when the stack starts:

1. `db` becomes healthy
2. `api` starts, becomes healthy
3. `ai` and `worker` and `web` start
4. Brief window where `api` is up but `ai` is still booting

If a dev (or test) hits the `/ai/tools/...` endpoint during that window, fluent-api's `callFluentAi` will hit `ECONNREFUSED` and return `Result.err({ code: AI_SERVICE_UNAVAILABLE, ... })`. This is the correct behavior — no need for retries, no need to invert the `depends_on` direction. Worth noting only so reviewers don't mistake the 502 they see during startup for a bug. (An optional improvement: add an `ai` healthcheck and let `api` declare a soft dependency on it. Out of scope for this PR but a candidate for the fluent-platform follow-up.)

### 12.6 Standalone-mode behavior when fluent-ai isn't running

When a dev runs only `./fapi.sh up` without fluent-ai, the `/ai/tools/...` endpoints will return `502 Bad Gateway` with `code: AI_SERVICE_UNAVAILABLE`. This is acceptable: the rest of fluent-api works, and the dev sees a clear signal that they need to bring fluent-ai up (or switch to ecosystem mode) if they want to exercise the AI integration.

### 12.7 README updates

- **fluent-api's README** gains a short subsection under "Running locally" pointing to fluent-platform for ecosystem mode and explaining the standalone-mode caveat.
- **fluent-platform's README** has a Services table at line 61–68 listing `api`, `ai`, `web`, `worker`, `db`. The proposed compose change in §12.4 doesn't add new services so this table is unaffected, but the Environment Configuration section (line 166+) should mention that `FLUENT_AI_KEY` must be set in `fluent-api/.env` to enable the AI tools endpoints.

### 12.8 What `callFluentAi` does _not_ assume about networking

The client is unaware of whether fluent-ai is at `localhost:8200`, `ai:8200`, `https://fluent-ai.internal.example.com`, or anywhere else. It reads `FLUENT_AI_URL` verbatim, appends `/api/v1/${toolPath}`, and POSTs. This means:

- Switching from standalone to ecosystem mode is a single env var change (handled automatically by the platform compose override).
- Switching to a staging or production deployment is a single env var change.
- TLS works automatically if `FLUENT_AI_URL` starts with `https://` — `fetch` handles it.

### 12.9 Production / deployment

Per [`fluent-platform/README.md`](../../../../fluent-platform/README.md) §"Deployment (placeholder - not active 2026-05-08)", Azure Bicep templates live in [`fluent-platform/deploy/azure/`](../../../../fluent-platform/deploy/azure/) but aren't active yet. When production deployment lands, `FLUENT_AI_URL` and `FLUENT_AI_KEY` will be wired through the same environment-injection mechanism the rest of the app uses (Azure App Settings / Key Vault references). No fluent-api code change is required for that transition.

### 12.10 Wiring up a running ecosystem (post-PR checklist)

The fluent-api code in this PR is complete, but **exercising it end-to-end against a live fluent-ai requires a small amount of local wiring that is intentionally _not_ part of this PR's committed changes** (the env values are machine-specific, and the compose override belongs to the paired fluent-platform PR per §12.4 / **D12**). This subsection is the runbook for an agent or developer who wants to take the merged code and watch a real request flow fluent-web → fluent-api → fluent-ai. It is deliberately step-by-step so it can be followed without prior context.

> **Prerequisites.** All four repos cloned side-by-side (the layout fluent-platform's setup produces). Docker/Podman available. fluent-ai's dev seed has run at least once so its `ai_api_keys` table contains the dev key `fai_dev_admin`. You are on branch `jel-word-check` in fluent-api.

**Step 1 — Add the two env vars to `fluent-api/.env`.** The repo only ships `.env.example`; the real `.env` is git-ignored and must be edited by hand. Append (or copy from `.env.example` — see §12.3):

```dotenv
FLUENT_AI_URL=http://localhost:8200
FLUENT_AI_KEY=fai_dev_admin
```

Use `http://localhost:8200` for standalone mode. In ecosystem mode the platform compose override (Step 2) replaces the URL with `http://ai:8200`, so the value here is only the standalone fallback — but it **must be present and non-empty** either way, because `src/env.ts` validates both vars at boot with no defaults (§12.2). A missing or blank value makes fluent-api exit on startup with a Zod error.

**Step 2 — Add the compose override in fluent-platform (paired PR, §12.4 / D12).** This is _not_ committed in the fluent-api PR. In [`fluent-platform/compose.yaml`](../../../../fluent-platform/compose.yaml), under the `api` service's `environment:` block, add:

```yaml
FLUENT_AI_URL: http://ai:8200
```

Do **not** add `FLUENT_AI_KEY` here — it is a shared secret sourced from `fluent-api/.env` so the caller key and fluent-ai's `ai_api_keys` seed stay in lockstep (§12.4 explains why overriding only one side invites drift).

**Step 3 — Bring the stack up (or restart just `api`).**

- Cold start: from `fluent-platform/`, run `./fluent.sh up` (ecosystem mode — brings up `db`, `api`, `worker`, `ai`, `web`).
- If the stack is already running and you only changed env/compose for `api`, restart just that one service so you don't disturb the database or other services — e.g. `docker compose restart api` (or the equivalent `./fluent.sh` subcommand). **Do not** tear down the stack or re-run any DB seed; that would needlessly rebuild Postgres.

**Step 4 — Verify both services are healthy.**

- fluent-api: `curl -fsS http://localhost:8787/health` (or the port your stack maps the `api` service to) should return its health payload.
- fluent-ai: `curl -fsS http://localhost:8200/health` (standalone) or, from inside the network, `http://ai:8200/health` should return healthy. There is a brief startup window where `api` is up but `ai` is still booting (§12.5); a 502 with `AI_SERVICE_UNAVAILABLE` during that window is expected, not a bug — just retry once `ai` is healthy.

**Step 5 — Obtain a BetterAuth bearer token.** The `/ai/tools/...` endpoint is guarded by `authenticateUser + requirePermission(AI_TOOLS_USE)` (§9), so an unauthenticated `curl` gets a 401. To call it from the host, sign in via BetterAuth and capture the session token. Sign-in returns the token in the `set-auth-token` response header (BetterAuth's bearer-token plugin), which you then send back as `Authorization: Bearer <token>`:

```bash
# Sign in with a seeded dev user; capture the set-auth-token header.
TOKEN=$(curl -sS -D - -o /dev/null \
  -X POST http://localhost:8787/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"<dev-user-email>","password":"<dev-password>"}' \
  | awk -F': ' 'tolower($1)=="set-auth-token"{print $2}' | tr -d '\r')
echo "token: ${TOKEN:0:12}..."
```

Use whatever dev credentials your local seed provisions. (Exact email/password are environment-specific — check your fluent-api/fluent-platform seed data; this runbook intentionally does not hard-code them.)

**Step 6 — Run the smoke script.** The script is committed in this PR at [`fluent-api/scripts/smoke-repeated-words.ts`](../../../scripts/smoke-repeated-words.ts) with the npm alias `smoke:repeated-words` (§13.3). It posts the canned 3-verse corpus and asserts the envelope is `completed`, `tool === "greek_room.repeated_words"`, `result.findings` is an array with exactly two entries (one legitimate, one suspicious), `summary.verse_count === 3`, and `summary.total_findings === findings.length`. From `fluent-api/`:

```bash
# Credential is passed as a CLI flag (note the `--` separating npm args from script args).
# Base URL defaults to $FLUENT_API_URL or http://localhost:9999; override with --url.
npm run smoke:repeated-words -- --url http://localhost:8787 --token "$TOKEN"

# Web-session alternative (raw Cookie header instead of a bearer token):
#   npm run smoke:repeated-words -- --url http://localhost:8787 --cookie "better-auth.session_token=..."
# The token may also be supplied via the FLUENT_API_TOKEN env var instead of --token.
# Add --raw to print the unchecked response body, or --timeout <seconds> to change the 30s default.
```

A successful run prints the parsed envelope, lists each sanity check as `ok`, and exits 0. Exit 2 means bad CLI args or a missing credential (no `--token`/`--cookie`/`FLUENT_API_TOKEN`). A 401/403 means the token wasn't captured or the user lacks `content:update`; a 502 with `AI_SERVICE_UNAVAILABLE` means fluent-api couldn't reach fluent-ai (re-check Steps 1–4); a 502 with `AI_TOOL_EXECUTION_FAILED` means fluent-ai was reached but the tool itself reported a failure (inspect the propagated `details`).

**Step 7 — (Optional) Drive it from the OpenAPI docs.** fluent-api serves Scalar docs at `/reference`; the `POST /ai/tools/greek-room/repeated-words` operation appears there with the full request/response schema (§5.2), so you can also exercise it interactively once authenticated.

> **Why this isn't committed.** The `.env` values are per-machine secrets and the compose override is the paired fluent-platform PR's responsibility (D12). Keeping this as a documented runbook — rather than baked-in config — preserves the standalone/ecosystem split (§12.1) and avoids committing a dev key or a topology-specific URL into the fluent-api repo.

---

## 13. Testing strategy

Per **D11**, the test footprint mirrors the existing fluent-api conventions. Three layers:

### 13.1 Unit tests — `callFluentAi`

File: `fluent-api/src/lib/services/fluent-ai/fluent-ai.client.test.ts`

Test surface, all with `global.fetch` stubbed via `vi.spyOn(global, 'fetch')`:

- Happy path: completed envelope → returns `Result.ok(envelope)`.
- Happy path: queued envelope → returns `Result.ok(envelope)` (the route layer, not the client, decides 200 vs 202).
- Failed envelope (`status: "failed"`) → returns `Result.err({ code: AI_TOOL_EXECUTION_FAILED, ... })`.
- Cancelled envelope → returns `Result.err({ code: AI_TOOL_EXECUTION_FAILED, ... })`.
- fluent-ai returns 4xx → `Result.err({ code: AI_SERVICE_UNAVAILABLE, ... })`.
- fluent-ai returns 5xx → `Result.err({ code: AI_SERVICE_UNAVAILABLE, ... })`.
- `fetch` rejects (network error) → `Result.err({ code: AI_SERVICE_UNAVAILABLE, ... })`.
- Response body fails JSON parse → `Result.err({ code: AI_SERVICE_UNAVAILABLE, message contains "malformed" })`.
- Response envelope passes parsing but `result` field fails the result schema → `Result.err({ code: AI_SERVICE_UNAVAILABLE, ... })`.
- Default 30s timeout fires via fake timers → `Result.err({ code: AI_SERVICE_UNAVAILABLE, ... })`.
- Caller-supplied `AbortSignal` triggers → `Result.err({ code: AI_SERVICE_UNAVAILABLE, ... })`.
- Request shape: `X-API-Key` header is present, equals `env.FLUENT_AI_KEY`, `Content-Type` is `application/json`, URL is `${FLUENT_AI_URL}/api/v1/${toolPath}`.

### 13.2 Domain tests — `ai-tools.route.ts`

File: `fluent-api/src/domains/ai-tools/ai-tools.route.test.ts`

Test surface, modeled on the existing HTTP-route coverage in [`fluent-api/src/server/server.test.ts`](../../../src/server/server.test.ts) and the domain-service test conventions in [`fluent-api/src/domains/projects/projects.service.test.ts`](../../../src/domains/projects/projects.service.test.ts):

- Unauthenticated request → 401.
- Authenticated but missing `AI_TOOLS_USE` → 403.
- Invalid request body (e.g. empty `verses`) → 400 with Zod details.
- Authenticated + permitted + valid body + happy-path mock of `callRepeatedWords` returning completed envelope → 200, envelope passed through verbatim.
- Same but mock returns queued envelope → 202, envelope passed through.
- Same but mock returns failed envelope → 502, error body.
- Same but mock returns transport error → 502, error body.
- Mock is asserted to have been called with the exact request body the caller sent (verifies no enrichment).

### 13.3 Smoke test — `scripts/smoke-repeated-words.ts`

A standalone script mirroring [`fluent-ai/scripts/smoke_repeated_words.py`](../../../../fluent-ai/scripts/smoke_repeated_words.py). Runs from the host against a live fluent-api + fluent-ai pair, posts a known-good body, and asserts:

- Returns 200 (today; 202 once fluent-ai goes async).
- Envelope `status` is `completed` (today).
- `result.findings` is an array.
- `result.summary.total_findings` equals `result.findings.length`.

Invoked via an npm script: `npm run smoke:repeated-words`. Not part of `npm test` (it requires a live stack). Documented in fluent-api's README alongside the existing dev workflow.

### 13.4 What is _not_ covered

- **No end-to-end fluent-web → fluent-api → fluent-ai test.** That's a frontend concern that will land with the frontend PR.
- **No load tests** for the polling endpoint (which doesn't exist yet on either side).
- **No contract tests** auto-generated from fluent-ai's OpenAPI spec. This would be valuable, but introducing a contract-testing framework (Pact, openapi-typescript code generation, etc.) is its own decision worth a separate spec. For now, the Zod schemas in fluent-api are the contract, hand-maintained against [`fluent-ai/src/app/schemas/greek_room.py`](../../../../fluent-ai/src/app/schemas/greek_room.py) and [`fluent-ai/src/app/schemas/tool_job.py`](../../../../fluent-ai/src/app/schemas/tool_job.py).

### 13.5 Test infrastructure inherited

- Vitest config in [`fluent-api/vitest.config.ts`](../../../vitest.config.ts) — no changes.
- Existing test helpers in `fluent-api/src/tests/` (auth fixtures, request helpers) — reused as-is for the domain tests.
- No new test dependencies.

---

## 14. Future work

Items that are out of scope for this PR but enabled by the foundations laid here. None of these is blocked on a redesign; they all plug into the same `callFluentAi` / `ToolJobResponse` shape.

### 14.1 The polling endpoint and slow tools

When fluent-ai introduces a tool that justifies the queue substrate (per fluent-ai decision **D1**, currently deferred), it will ship:

- A backing `ai.tool_jobs` table.
- An in-process worker for execution.
- `GET /api/v1/tools/jobs/{job_id}` for status polling.

The matching fluent-api work is small:

- Add `pollToolJob(jobId, resultSchema)` sibling to `callFluentAi` in [`fluent-api/src/lib/services/fluent-ai/fluent-ai.client.ts`](../../../src/lib/services/fluent-ai/fluent-ai.client.ts).
- Add `GET /ai/tools/jobs/{job_id}` route in [`fluent-api/src/domains/ai-tools/ai-tools.route.ts`](../../../src/domains/ai-tools/ai-tools.route.ts) with the same `authenticateUser + requirePermission(AI_TOOLS_USE)` middleware.
- No DB persistence needed on the fluent-api side — fluent-api remains a thin pass-through; the job state of record lives in fluent-ai's `ai.tool_jobs` table.

### 14.2 Frontend hook and editor squiggles

A separate PR against fluent-web will introduce the `useToolJob` + `useRepeatedWords` hooks sketched in §11.4, then drive editor squiggle UI from the `findings` array. The backend surface is already shaped to feed that UI directly (`snt_id`, `surf`, `start_position`, `severity` on each finding).

### 14.3 Additional Greek-Room checks

Greek-Room exposes other static-analysis tools (punctuation, untranslated text, character-set sanity, etc.). Each will land in fluent-ai as a sibling tool, then surface in fluent-api with the same five-line pattern shown in §7.5. No new mechanism needed.

### 14.4 Other AI tool families

The same pattern absorbs LLM drafting, embeddings, fine-tuning, and any other tool family fluent-ai grows into. The naming convention `tools/{family}/{tool-name}` (e.g. `tools/openai/draft-suggestion`, `tools/embeddings/similarity`) keeps OpenAPI documentation organized.

### 14.5 Per-user attribution

Today fluent-ai sees a single shared identity (`FLUENT_AI_KEY`). If audit / billing / rate-limiting needs per-user attribution later, fluent-api can pass an opaque `X-Requested-By` header carrying the BetterAuth user ID. fluent-ai logs it; no change to the request body.

### 14.6 Caching for idempotent tools

`callFluentAi` is intentionally cache-free today. Some future tools may be both expensive and deterministic on their input — in which case a `(toolPath, hash(body))` cache (in-memory or Redis) makes sense. Drops in at the `callFluentAi` layer without changing call sites.

### 14.7 Retries on transport failure

Currently `callFluentAi` does not retry on network errors. If experience shows transient failures are common, a `withRetry` wrapper (analogous to [`withDatabaseRetry`](../../../src/lib/db-retry.ts)) can be added at the client level. Out of scope today because the failure mode of the only tool is "semantic," not "flaky."

### 14.8 MCP facade

A future Model Context Protocol facade (referenced as out-of-scope in [`fluent-ai/greek-room-integration-summary.md`](../../../../fluent-ai/greek-room-integration-summary.md)) could be layered over fluent-ai. fluent-api would call it via `callFluentAi` exactly as today — the only difference is the base URL.

### 14.9 fluent-platform refinements

Two small, optional improvements identified while writing this spec:

- Add a healthcheck to the `ai` service in [`fluent-platform/compose.yaml`](../../../../fluent-platform/compose.yaml) and let `api` declare a soft dependency on it. Would eliminate the brief startup window where the AI endpoints return 502. Not pursued in this PR because the 502 response is already graceful.
- Document the `FLUENT_AI_KEY` ↔ fluent-ai `ai_api_keys` table relationship in [`fluent-platform/docs/`](../../../../fluent-platform/docs/) for new developers.

---

## 15. Open questions for reviewer

These are the items the spec discussion landed on but where reviewer pushback would meaningfully change the outcome. Each one has a recommended position (the doc reflects this); each one can be flipped without restructuring the rest of the proposal.

> **Status: resolved.** All four questions below were addressed in kaseywright's review of [PR #173](https://github.com/eten-tech-foundation/fluent-api/pull/173) on 2026-06-02 (review **APPROVED**). The reviewer confirmed each recommended position; two of them (§15.2, §15.4) came with a request to document the decision, now captured in §9.3 and §8.1 respectively. Per-item resolutions are noted inline below.

### 15.1 URL layout: is `POST /ai/tools/greek-room/repeated-words` the right shape?

**Recommended:** Yes — see **D2** and §5.

> **Resolved (kaseywright, 2026-06-02):** confirmed — "this URL layout works well." [Review comment.](https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343625894)

**Alternatives:**

- `POST /checks/repeated-words` — closer to the verbiage we use elsewhere ("checks" rather than "tools"). Downside: hides the network-bound, possibly-async nature of these endpoints.
- `POST /chapter-assignments/{id}/checks/repeated-words` — nests the check under the resource it operates on. Rejected because it requires fluent-api to enrich the request body from `chapter_assignment_id` → verses + language metadata, which couples fluent-api to fluent-ai's input schema (rejected by **D8**).
- `POST /tools/dispatch` with `{tool: "...", params: {...}}` — collapses the type system at the wire boundary. Same reason fluent-ai rejected this (see [`fluent-ai/greek-room-integration-summary.md`](../../../../fluent-ai/greek-room-integration-summary.md) §1).

**Decision needed from reviewer:** confirm `/ai/tools/{family}/{tool}` or push back with a preference.

### 15.2 Permission: `PERMISSIONS.AI_TOOLS_USE` as a string-value alias of `CONTENT_UPDATE`?

**Recommended:** Yes, alias — see **D10** and §9.3.

> **Resolved (kaseywright, 2026-06-02):** alias approach confirmed, with the request to document the decision for future reference (done in §9.3). [Review comment.](https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343633722)

**Alternatives:**

- Introduce a real new permission row in the `permissions` table with its own role mappings. Requires a migration and seed update. Gives nothing user-visible today but is the "cleaner" RBAC story.
- Reuse `PERMISSIONS.CONTENT_UPDATE` directly at the call site (no alias). Loses the documentary value of seeing "AI_TOOLS_USE" at the route.

**Decision needed from reviewer:** confirm the alias approach or push back for either of the alternatives.

### 15.3 Envelope pass-through vs. unwrapping `result` for the sync case?

**Recommended:** Pass through the full `ToolJobResponse` — see **D9** and §8.2.

> **Resolved (kaseywright, 2026-06-02):** pass-through confirmed, conditioned on the web-client response following the standard format already in place (see §8.2). [Review comment.](https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343642943)

**Alternatives:**

- For the synchronous case only, return just the `result` field (i.e. `{findings, summary}`) and 200, reserving the envelope for when fluent-ai goes async. Simpler today; mildly more breaking when polling lands.
- Pass through always but add a thin `result_only` query parameter for callers that want the unwrapped shape. Adds API surface for negligible benefit.

**Decision needed from reviewer:** confirm pass-through or push back for unwrap-now-envelope-later.

### 15.4 No request enrichment vs. server-side context augmentation?

**Recommended:** No enrichment — see **D8** and §8.1.

> **Resolved (kaseywright, 2026-06-02):** forwarding verbatim confirmed; the snake_case naming divergence accepted as a contained, intentional AI-tools-domain exception, with a request to document it (done in §8.1). [Review comment.](https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343677813)

**Alternatives:**

- fluent-api looks up `chapter_assignment_id` (or `project_id`) and adds verses + language metadata server-side. Caller sends a thin reference, fluent-api fattens it before forwarding. Trades client flexibility for harder-to-spoof inputs.
- Hybrid: caller sends the full body, fluent-api _validates_ certain fields against its own data (e.g. confirms the caller has access to that `project_id`). Lighter than full enrichment.

**Decision needed from reviewer:** confirm no enrichment, or push back for either alternative.

### 15.5 Anything else the reviewer wants surfaced

If reviewers identify a concern not captured above, please raise it as a comment on the PR. The relevant pre-decisions are summarized in §3 and the rationale is in the predecessor docs ([`fluent-ai/greek-room-integration-summary.md`](../../../../fluent-ai/greek-room-integration-summary.md), [`fluent-ai/greek-room-integration-suggestion.md`](../../../../fluent-ai/greek-room-integration-suggestion.md), [`fluent-ai/greek-room-integration-decisions.md`](../../../../fluent-ai/greek-room-integration-decisions.md)).

---
