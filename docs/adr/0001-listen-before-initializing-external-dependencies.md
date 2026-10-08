# Open the HTTP listener before initializing external dependencies

On 2026-10-01 a routine deploy to `scribe-server-dev` (Basic B1, single
instance) coincided with a database connectivity flap. Because `index.ts`
awaited `verifyBlobStorageOnBoot()` and `initializeQueue()` before calling
`serve()`, the port never opened inside Azure's 230-second startup-probe
window, the platform stopped the site, and the app was down ~35 minutes even
though the database itself never went down.

**Decision:** `serve()` runs first; blob verification, queue initialization,
and audio-storage probing run in the background afterward. Queue init retries
with backoff until shutdown (`initializeQueueWithRetry`), so a transient outage
self-heals. While the queue is not ready, queue-dependent routes answer 503 via
`isQueueReady()` — the same degrade-first convention `isBlobStorageConfigured()`
already used. The standalone WebJob keeps fail-fast startup: a worker with no
queue is useless, and WebJob restart is already its retry loop.

**Considered:** fail-fast on boot (the old behaviour — this was the incident);
waiting for dependencies but raising `WEBSITES_CONTAINER_START_TIME_LIMIT`
(doesn't help — the flap lasted minutes, and a listening-but-degraded app beats
a not-listening one).

**Consequences:** callers of `getQueue()` can now observe the not-ready window
in production, not just in tests; `isQueueReady()` is the contract for "can I
send". The DLQ monitor starts whenever the queue comes up — it no longer
implies the process just booted.
