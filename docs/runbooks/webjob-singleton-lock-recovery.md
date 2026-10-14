# WebJob singleton lock recovery

How to recover the `worker` continuous WebJob when it is stuck in
`InactiveInstance` because a previous app instance died holding the Kudu
singleton file lock.

> **Deprecated mechanism.** `is_singleton` was removed from the generated
> `settings.job` after the 2026-10 QA outage: pg-boss already claims each job
> atomically, so per-instance workers cannot double-process. Once an
> environment runs a deployment built without `is_singleton`, this failure mode
> no longer applies there (leftover `singleton.job.lock` files on shared
> storage are inert). Keep this runbook for environments still on a
> singleton-enabled deployment.

Applies to every App Service that hosts this worker (e.g. `fluent-server-qa`,
`fluent-server-prod`). Older WebJobs are produced by `scripts/setup-webjob.js`
with `is_singleton: true`, so Kudu guards them with a file-lease lock on
shared storage.

## Symptoms

- `az webapp webjob continuous list -g <rg> -n <app>` reports
  `status: "InactiveInstance"` (detailed status `<instance> - InactiveInstance`)
  even though the app has only one instance.
- Portal/API "Start Continuous WebJob" operations fail; the activity log shows
  `Start Web Apps Continuous Web Jobs` → `Failed`.
- `data/jobs/continuous/worker/job_log.txt` contains nothing but
  `SYS INFO] Waiting for 00:00:30 before stopping` repeating every ~30 seconds,
  across many instance IDs.
- No `Worker heartbeat` traces in Application Insights; pg-boss queues grow and
  DLQ depth warnings (`worker_dlq_depth`, emitted by the API, not the worker)
  keep firing because dead-lettered rows are never drained or replayed.
- The API itself stays healthy — only the background worker is dead.

## Cause

Kudu implements `is_singleton` by exclusively creating
`data/jobs/continuous/worker/singleton.job.lock` on the site's shared storage.
The file records the holder's `InstanceId` and a `.heartbeat` sidecar file the
holder refreshes while alive. If the holding instance is hard-killed (VM
recycle, OOM kill, platform move) the lock file is left behind. Every later
instance then sees the lock as held by "another instance", marks itself
`InactiveInstance`, and loops on `Waiting for 00:00:30 before stopping`
indefinitely. App restarts do not clear it — the file is on shared storage and
survives every recycle.

## Diagnose before deleting

Only delete the lock when the recorded holder is provably gone. Deleting a lock
that a live instance holds lets two workers run and breaks the singleton
guarantee.

```sh
# 1. List live app instances (note the short 6-char prefix each log/status uses)
az webapp list-instances -g <rg> -n <app> -o table

# 2. Read the lock holder (substitute your SCM host + basic publishing creds)
curl -s -u "$USER:$PASS" \
  "https://<app>.scm.<region>.azurewebsites.net/vfs/data/jobs/continuous/worker/singleton.job.lock"
# -> { "InstanceId": "6c9ba2", "AcquiredDateTime": "...", ... }

# 3. Check the heartbeat file's mtime in the directory listing
curl -s -u "$USER:$PASS" \
  "https://<app>.scm.<region>.azurewebsites.net/vfs/data/jobs/continuous/worker/"
```

If `InstanceId` does not match a live instance prefix from step 1 **and** the
`singleton.job.lock.heartbeat` mtime is stale (older than ~15 minutes), the
lock is orphaned and safe to remove. If the holder IS live, this is a real
singleton — the job is running elsewhere; do not delete.

Publishing credentials:

```sh
az webapp deployment list-publishing-credentials -g <rg> -n <app> \
  --query "{u:publishingUserName, p:publishingPassword}"
```

## Recovery

Kudu VFS deletes require an `If-Match` ETag (a plain DELETE returns
`ETag does not represent the latest state of the resource`).

```sh
for f in singleton.job.lock singleton.job.lock.heartbeat; do
  ETAG=$(curl -s -u "$USER:$PASS" -I \
    "https://<app>.scm.<region>.azurewebsites.net/vfs/data/jobs/continuous/worker/$f" \
    | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)
  curl -s -u "$USER:$PASS" -X DELETE -H "If-Match: $ETAG" \
    "https://<app>.scm.<region>.azurewebsites.net/vfs/data/jobs/continuous/worker/$f"
done
```

The running instance's job runner retries lock acquisition about once a minute
and recreates the lock under its own `InstanceId` — no explicit start is
required. If it does not transition within ~5 minutes, nudge it:

```sh
az webapp webjob continuous start -g <rg> -n <app> --webjob-name worker
```

A first boot can take several minutes (the job package is a ~177 MB zip that
Kudu extracts to `/tmp/jobs/continuous/worker/<hash>/` before `run.sh` runs).

## Verify

```sh
az webapp webjob continuous list -g <rg> -n <app> \
  --query "[].{status:status, detailed:detailedStatus}"
# expect: status "Running"
```

`job_log.txt` should show `Run script 'run.sh'`, `Status changed to Running`,
then `Starting pg-boss worker in WebJob`, `Worker started and listening for
jobs`, and `Worker heartbeat` every ~5 minutes.

Caveat: Kudu stops appending job stdout after its per-run line cap
(`Reached maximum allowed output lines for this run`). The job keeps running;
use Application Insights for continued visibility:

```kusto
traces
| where timestamp > ago(30m)
| where message contains "Worker heartbeat"
| order by timestamp desc
```

Alert when heartbeats go missing rather than on `InactiveInstance` alone —
a sustained `samples == 0` over 10 minutes catches both this lock failure and a
genuinely crashed worker.

## After recovery

Expect a queue backlog drain — the worker catches up on `usfm-export`,
`ai-suggestions`, and `dbl-ingest-text` jobs accumulated during the outage.
Dead-lettered rows do **not** self-replay; investigate and replay them per
[worker-dead-letter-queues.md](./worker-dead-letter-queues.md).

## Related failure seen during the 2026-10 incident

A stale lock is not the only way the worker silently stops: on QA the same
outage window also contained a transient
`password authentication failed for user "web_user"` storm (DB credential
rotation) and `fluent-ai returned HTTP 401 TOKEN_INVALID` batches filling
`ai-suggestions-dlq` — `FLUENT_AI_KEY` must match a row in fluent-ai's
`ai_api_keys` table. Check the tail of `job_prev_log.txt` for the last real
worker errors when the timeline of an outage is unclear.
