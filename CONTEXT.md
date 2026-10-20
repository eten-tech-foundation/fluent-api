# Fluent API

Translation-project API — Hono on Node, Postgres via Drizzle for data and
pg-boss for jobs, Cloudflare R2 for file storage. Single context; this file is
the glossary for the whole repo.

## Language

**Degraded startup**:
The HTTP listener opens before external dependencies (pg-boss queue, R2 probes)
finish initializing, so a dependency outage at boot cannot take the site down.
While the queue is not ready, queue-dependent endpoints answer 503 and keep
retrying in the background.
_Avoid_: "warming up", "broken" — degraded is a deliberate, recoverable state,
not a failure.

**Dead-letter queue (DLQ)**:
Terminal destination queue named `<source>-dlq` holding jobs that exhausted
retries. The app monitors DLQ depth every minute but never consumes, replays,
or purges it — that is an operator action per the runbook.
_See_: docs/runbooks/worker-dead-letter-queues.md

**Worker (WebJob)**:
The continuous Azure WebJob under `App_Data/jobs/continuous/worker/` that runs
`standalone-worker.ts` on the same app service plan. It ships inside the API's
deployment package and resolves its dependencies from the app's own
`node_modules` — it does not carry a separate copy.
_Avoid_: "background service", "daemon" — it is a WebJob in the same deploy.
