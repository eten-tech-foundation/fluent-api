# Ticket 3 — Async export pipeline hardening (pre-enablement)

**Priority:** P2 — the async pipeline is **not wired to the UI**, so this is
"fix before enabling," not a live outage.
**Status:** Implemented (2026-07-02, #196): short-lived signed download URLs,
worker fails/retries properly (batchSize 1 + dead-letter queue), streaming upload
(no in-memory buffering), owner-bound jobs/downloads, and `singletonKey` dedupe.
Storage backend migrated Azure Blob → Cloudflare R2 (S3-compatible) in #212 for
EU data-at-rest (GDPR). **Remaining:** provision R2 credentials (`R2_ACCOUNT_ID` /
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`) + an EU-jurisdiction exports bucket
per hosted environment — the endpoints respond 503 until configured. R2 has no
local emulator; use MinIO or a real R2 dev bucket for local compose.

## Context

`POST /project-units/{id}/usfm/async` enqueues a pg-boss job (`USFM_EXPORT`) that
`src/workers/standalone-worker.ts` processes, streaming the ZIP into Cloudflare
R2; the client then polls `GET /jobs/{id}` and follows the 302 from
`GET /downloads/{filename}` to a signed URL. No `fluent-web` code calls these
routes today.

## Defects to fix before exposing it

1. **Failures marked as success.** `usfm-export.worker.ts` uses
   `Promise.allSettled` + `return results.map(...)`, so the handler always
   resolves; pg-boss marks failed jobs `completed` and `retryLimit: 3` never
   fires. Fix: `batchSize: 1` and throw on failure, or re-throw if any settled
   result is `rejected`. Ensure terminal failures log to App Insights.
2. **Cross-process file storage.** API and worker run as separate processes
   (compose mounts a _separate_ `/app/exports` tmpfs per container, confirmed
   against `compose.yaml`; the API entrypoint `src/index.ts` only creates the
   queue, it does not register the worker). A worker-written file is invisible to
   the API serving `/downloads`
   → 404. Fix: shared object storage (S3-compatible) + signed URL, or a shared
   persistent volume mounted in both. **Decided (reviewer, 2026-06-26): object
   storage + signed URLs; superseded 2026-07 (#212 review) to Cloudflare R2
   (S3-compatible) for EU data-at-rest (GDPR).** Needs R2 credentials + an
   EU-jurisdiction bucket provisioned per environment (MinIO or a real R2 bucket
   for local compose).
3. **Whole ZIP buffered in memory.** The worker drains the archive stream into a
   `Buffer` before writing (`usfm-export.worker.ts` + `file-storage.ts`), risking
   OOM on large exports. Fix: stream to disk/storage via `stream.pipeline`.
4. **No idempotency / owner binding.** `boss.send()` sets no `singletonKey`
   (duplicate requests re-export); `/jobs/{id}` and `/downloads/{filename}` are
   only `authenticateUser`-gated (ticket 1) and not bound to the requesting
   user/org. Persist the owner at enqueue time and verify on access; add a
   `singletonKey` from `projectUnitId` + sorted `bookIds`; lower
   `expireInSeconds` from 3600 to a realistic ceiling.

## Acceptance criteria

- A failing job ends in `failed` (after retries), is logged to App Insights, and
  is never reported as a successful export.
- A queued export is downloadable by its owner regardless of which process serves
  the request; other users/orgs cannot download it.
- Large exports do not OOM the worker.
