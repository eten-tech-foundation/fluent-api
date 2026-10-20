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

**TTS licence status**:
Whether text-to-speech may be generated from a Bible's text: _allowed_,
_forbidden_, or _unknown_. A fact about the published Bible, not a grant to a
user or organization. Only _allowed_ permits synthesis.
_Avoid_: "TTS permission", "TTS access" — those mean the user-level `TTS_USE`.

**Unknown (licence status)**:
Nobody has decided yet. Treated exactly like _forbidden_ for synthesis, and it
is what "flagged for review" means. New or unrecognised licences land here
(deny-by-default).
_Avoid_: "pending", "unreviewed", or "flagged" as a separate state.

**Licence notice**:
The provider's free-text copyright statement for a Bible (DBL's `copyright`).
This is the "license" that is captured and classified; DBL has no structured
licence field.
_Avoid_: "license type", "license code".

**All rights reserved**:
A licence notice that reserves all rights. Always _forbidden_ — the one hard
rule.

**Licence fence**:
The single place in the web client that reads a Bible's TTS licence status
and refuses to request synthesis unless it is _allowed_. It bars synthesis
only; recorded audio is unaffected.
