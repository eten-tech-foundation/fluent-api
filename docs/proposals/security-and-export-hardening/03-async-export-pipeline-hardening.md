# Ticket 3 — Async export pipeline hardening (pre-enablement)

**Priority:** P2 — the async pipeline is **not wired to the UI**, so this is
"fix before enabling," not a live outage.
**Status:** Not started.

## Context

`POST /project-units/{id}/usfm/async` enqueues a pg-boss job (`USFM_EXPORT`) that
`src/workers/standalone-worker.ts` processes, writing a ZIP to `EXPORTS_DIR`; the
client then polls `GET /jobs/{id}` and downloads `GET /downloads/{filename}`. No
`fluent-web` code calls these routes today.

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
   → 404. Fix: shared object storage (S3 / Azure Blob) + signed URL, or a shared
   persistent volume mounted in both.
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
