# Worker dead-letter queues

Issue [#256](https://github.com/eten-tech-foundation/fluent-api/issues/256) follows
the retry handling added in [#212](https://github.com/eten-tech-foundation/fluent-api/pull/212).

## Decision

Keep dead-letter queues unconsumed and report their depth on API startup and every
60 seconds. A warning with `event=worker_dlq_depth` and `depth > 0` confirms that
retained jobs exist in a DLQ. Ordinary retry attempts remain in the source queue
and do not produce this signal. This is a backlog gauge, not an exactly-once
per-job event or a count of new failures.

The API runs the monitor because the export WebJob refuses to boot without R2.
Monitoring therefore continues when that worker cannot start. It uses the existing
Pino/Application Insights logger, needs no new service or fluent-platform change,
and stops its timer and waits for an active sweep before stopping pg-boss.
Slow sweeps never overlap. Discovery failures and individual queue read failures
emit `worker_dlq_monitor_error`; a failure in one queue does not skip the others.

Every API replica reports independently. Treat depth as a gauge and use the latest
sample, not a sum of samples or instances. Production Application Insights requires
the existing `APPLICATIONINSIGHTS_CONNECTION_STRING`; without it, logs are local
only. The code emits telemetry; Azure alert rules and notification destinations
still need to be configured by the environment owner.

## Queue convention

Use `ensureWorkerQueue(boss, name, options)` before sending or consuming jobs.
It creates `<name>-dlq` first and updates the source's `deadLetter` setting even
when the source already exists. Export and AI retry settings stay at three retries
with 60-second exponential backoff. DBL queues keep their current retry settings
(pg-boss defaults for new queues).

This applies to `usfm-export`, `ai-suggestions` (formerly
`ai-suggestion-trigger`), both `dbl-ingest-text` queues, and `dbl-sync` when its
optional worker is registered. This change does not enable the DBL sync worker or
add a schedule. The monitor discovers all configured dead-letter targets plus
all existing `*-dlq` queues, including orphaned legacy queues. Future queues using
the helper are included on the next sweep.

The monitor only reads names, counts and the oldest creation time. It never fetches
jobs, acknowledges them, logs payloads, replays them, or deletes them. Each sample
has flat `event`, `queueName`, `depth`, `queuedCount`, `activeCount`,
`deferredCount`, and `oldestCreatedOn` dimensions. Depth counts every retained row,
including a row accidentally consumed by another process. Deferred jobs are also
queued, so adding those two counts would count them twice.

The query reads the `pgboss.job` parent table (including partitions) through the
existing pg-boss connection. This deliberately avoids pg-boss **12.1.1**
`getQueueStats`: when no rows remain, that implementation can return cached
nonzero counters. A SQL aggregate without `GROUP BY` reliably reports zero. Keep
the integration test when upgrading pg-boss or changing its configured schema.

## Retention and rollout

New DLQ entries have at least **30 days** of retention from arrival. Longer existing
queue retention is preserved. pg-boss maintenance removes unconsumed jobs after
`keep_until`; completed/cancelled/failed jobs are removed after
`completed_on + deletion_seconds`. Both DLQ settings have a 30-day minimum.
This corrects the assumption in the issue that pg-boss keeps jobs indefinitely.

Queue settings are copied into jobs when they are inserted. Updating the queue
does **not** rewrite existing source or DLQ rows, reset their clocks, recover
previous failures, or move old jobs to a new DLQ. In particular:

- Existing DLQ rows retain their original deadline (normally 14 days). Export
  evidence needed beyond that deadline to approved restricted storage before it
  expires. Do not assume rollout grants those rows another 30 days.
- AI/DBL jobs sent before their source had `deadLetter` still have no DLQ target.
  Inspect their failed source rows and per-attempt logs during rollout.
- Legacy export queues with a different immutable policy are preserved, including
  completed/failed history. Startup emits `worker_queue_policy_mismatch`. Resolve
  that policy through an explicit migration after reviewing and preserving all
  work; startup no longer drops and recreates a queue. New export queues use
  `exclusive` as before.

There is no automated replay or application cleanup. pg-boss's existing maintenance
schedule controls when expired entries are removed. Roll back the application code
without dropping the queues; existing messages and their stored routing still need
their DLQ destinations. An older binary may resume its old queue-recreation logic,
so check legacy policy mismatches before rolling back.

## Investigate and recover

1. Confirm the queue and oldest timestamp from the latest depth sample. Check
   `worker_dlq_monitor_error` if a queue has stopped reporting. A warning on a
   nonzero backlog repeats every minute until that backlog is resolved or expires.
2. Inspect the destination's `id`, `data`, `output`, `created_on` and `keep_until`
   using authorized, read-only database access. Treat payloads and error outputs
   as private operational data. The DLQ has a **new job ID**: pg-boss copies payload
   and failure output, not the source ID. Correlate with source jobs and worker logs;
   payload equality alone is not proof of identity.
3. Fix the dependency/configuration problem and verify the worker can run. Review
   the job's current business state and idempotency before replay, especially AI
   requests that may already have produced external side effects.
4. Select specific source jobs for an operator-controlled retry, or explicitly
   enqueue a reviewed payload if the source row is gone. Confirm completion before
   resolving the corresponding retained DLQ entry. No bulk drain/purge command is
   part of this runbook. Retained evidence continues to count until an operator
   resolves it or its retention expires.

## Application Insights queries

For a backlog alert, evaluate every minute over a 10-minute window and trigger
when the result has at least one row. Use the latest value per role and queue so
multiple API replicas and repeated samples do not inflate the count:

```kusto
traces
| where timestamp > ago(10m)
| where tostring(customDimensions.event) == "worker_dlq_depth"
| extend queueName = tostring(customDimensions.queueName),
         depth = toint(customDimensions.depth),
         oldestCreatedOn = todatetime(customDimensions.oldestCreatedOn)
| summarize arg_max(timestamp, *) by cloud_RoleName, queueName
| where depth > 0
| project timestamp, cloud_RoleName, queueName, depth, oldestCreatedOn
```

Alert separately on monitor failures; missing telemetry must not mean an empty queue:

```kusto
traces
| where timestamp > ago(10m)
| where tostring(customDimensions.event) == "worker_dlq_monitor_error"
| project timestamp, cloud_RoleName, cloud_RoleInstance,
          queueName = tostring(customDimensions.queueName),
          error = tostring(customDimensions.error)
```

For a missing-signal rule scoped to the API's Application Insights resource,
trigger when `samples == 0` (including when the API itself is down):

```kusto
traces
| where timestamp > ago(10m)
| where tostring(customDimensions.event) == "worker_dlq_depth"
| summarize samples = count()
| where samples == 0
```

On a workspace-scoped Logs view, use `AppTraces`, `TimeGenerated`, `Properties`,
`AppRoleName` and `AppRoleInstance` in place of the corresponding resource-scoped
names above. Bind rules to the environment's approved action group. This PR does
not create live alert resources or send notifications.
See the [Azure AppTraces table reference](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/apptraces)
for workspace column names.

## Local validation

The `Dead-letter queue integration` PR check runs against a fresh PostgreSQL 16
service. Unit tests cover non-destructive setup, retention, current AI routing, queue
discovery, structured logs, partial failures, timer recovery and shutdown.
The opt-in PostgreSQL suite uses the real pg-boss engine and export/AI worker
handlers, replacing only their external export/storage/AI dependencies and logger.
It checks failed retries, terminal routing, recovery, payload/output preservation,
legacy rows, worker timeout, retention expiry, and a return to zero depth.

Use a fresh, isolated PostgreSQL 16 container with a random loopback port:

```sh
docker run --name fluent-dlq-test -e POSTGRES_PASSWORD=dlq-local-test \
  -e POSTGRES_DB=fluent_dlq_test -p 127.0.0.1::5432 -d postgres:16-alpine
docker port fluent-dlq-test 5432
# Substitute the returned port. Never use the application's DATABASE_URL.
DLQ_TEST_DATABASE_URL=postgres://postgres:dlq-local-test@127.0.0.1:PORT/fluent_dlq_test \
  npm test -- --run src/lib/dead-letter-queues.integration.test.ts --maxWorkers=2
```

The suite refuses non-loopback hosts, another database name, or a database with
existing application queues. It leaves its synthetic evidence in that disposable
database for inspection. Use a fresh test database on subsequent runs. No R2,
fluent-ai, hosted database, alerting resource or production queue is accessed.
