# Queue Monitoring & Alerts

Parent issue: [#393](https://github.com/eten-tech-foundation/fluent-api/issues/393) (Worker telemetry, queue metrics, and alert infrastructure)  
Task: [#399](https://github.com/eten-tech-foundation/fluent-api/issues/399) (Queue alert rule set + provisioning script + ops runbook)  
Related: [Worker dead-letter queues](worker-dead-letter-queues.md)

This runbook covers the Azure Monitor scheduled-query alert rules configured for the background worker and pg-boss queue infrastructure in `fluent-api`.

---

## Alert rule set

The following table summarizes the five scheduled-query alert rules provisioned for each environment. Detailed incident response procedures for each rule are provided below.

| Name                                                                    | Signal                                 | KQL query                                                                                                                               | Threshold                                | Severity     | Window        | What it means                                                                                             | Response action                                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------ | ------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Worker heartbeat missing** (`fluent-<env>-worker-heartbeat-missing`)  | Custom metric `worker_queue_size`      | `customMetrics \| where timestamp > ago(15m) \| where name == 'worker_queue_size' \| summarize samples = count() \| where samples == 0` | `samples == 0`                           | 1 (Critical) | 15m (freq 5m) | Worker process stopped sending 5m heartbeat metric; worker crashed, hung, or container terminated         | Check App Service / Container logs for crash/OOM; restart worker process; verify DB connectivity                                  |
| **DLQ depth > 0** (`fluent-<env>-worker-dlq-depth`)                     | Custom metric `worker_dlq_depth`       | Latest sample per worker instance and queue                                                                                             | latest `value > 0`                       | 2 (Warning)  | 10m (freq 5m) | One or more dead-letter queues contain failed jobs after exhausting retries                               | Follow [Worker dead-letter queues](worker-dead-letter-queues.md) runbook: inspect payloads, resolve root cause, replay or resolve |
| **DLQ monitor error** (`fluent-<env>-worker-dlq-monitor-error`)         | Trace event `worker_dlq_monitor_error` | `traces \| where timestamp > ago(10m) \| where tostring(customDimensions.event) == 'worker_dlq_monitor_error' \| summarize count()`     | `count > 0`                              | 2 (Warning)  | 10m (freq 5m) | Worker DLQ monitor sweep failed (database error, permissions, or connection timeout)                      | Query `worker_dlq_monitor_error` traces; verify PostgreSQL connectivity and permissions on `pgboss.job`                           |
| **Queue backlog growing** (`fluent-<env>-worker-queue-backlog-growing`) | Custom metric `worker_queue_size`      | First vs. last sample per worker instance                                                                                               | last `value >` first and `> 10`          | 2 (Warning)  | 30m (freq 5m) | Total queue size increased over 30m and backlog exceeds 10 jobs; arrival rate exceeds processing capacity | Inspect active jobs, slow jobs, and external dependencies (R2, OpenAI, DBL); scale worker instances if needed                     |
| **Worker memory high** (`fluent-<env>-worker-memory-high`)              | Custom metric `worker_rss_mb`          | Latest sample per worker instance                                                                                                       | latest `value > 450` (or plan threshold) | 2 (Warning)  | 15m (freq 5m) | Worker RSS memory exceeded 450 MB (~80% of 512MB Basic B1 plan); risk of OOM termination                  | Inspect memory leaks, heap vs RSS, and large in-flight job payloads; scale up App Service plan if workload demands it             |

---

## Alert details & response procedures

### 1. Worker heartbeat missing

- **Rule name**: `fluent-${ENVIRONMENT}-worker-heartbeat-missing`
- **Severity**: 1 (Critical)
- **Evaluation window**: 15 minutes, evaluated every 5 minutes
- **Trigger**: No `worker_queue_size` metrics recorded in Application Insights during the past 15 minutes.
- **KQL query**:
  ```kusto
  customMetrics
  | where timestamp > ago(15m)
  | where name == 'worker_queue_size'
  | summarize samples = count()
  | where samples == 0
  ```
- **Context**: The standalone worker emits a heartbeat metric (`worker_queue_size`, `worker_active_jobs`, `worker_rss_mb`, `worker_heap_used_mb`) every 5 minutes. If no samples are received within 15 minutes, three consecutive heartbeats have failed.
- **Operational response**:
  1. Check worker process status in Azure App Service / WebJob or Container App:
     ```sh
     az webapp show --name <worker-app-name> --resource-group <rg-name> --query "state"
     ```
  2. Inspect container standard out / error logs for crash indicators, fatal unhandled rejections, or exit codes:
     ```kusto
     traces
     | where timestamp > ago(1h)
     | where message has "heartbeat" or message has "shutdown" or severityLevel >= 3
     | order by timestamp desc
     ```
  3. Verify PostgreSQL database availability and network access from the worker host.
  4. If the worker process has hung or died, restart the service and monitor for the resumption of heartbeat logs (`Worker heartbeat`).

### 2. DLQ depth > 0

- **Rule name**: `fluent-${ENVIRONMENT}-worker-dlq-depth`
- **Severity**: 2 (Warning)
- **Evaluation window**: 10 minutes, evaluated every 5 minutes
- **Trigger**: The most recent sample for any monitored dead-letter queue reports a depth greater than 0.
- **KQL query**:
  ```kusto
  customMetrics
  | where timestamp > ago(10m)
  | where name == 'worker_dlq_depth'
  | extend queueName = tostring(customDimensions.queueName),
           workerInstance = tostring(cloud_RoleInstance)
  | summarize arg_max(timestamp, *) by workerInstance, queueName
  | where value > 0
  ```
- **Context**: When a background job (such as `usfm-export`, `ai-suggestions`, `usfm-import-materialize`, or `dbl-ingest-text`) exhausts all retry attempts, pg-boss moves it to its designated dead-letter queue (`<queue>-dlq`). Unconsumed jobs in a DLQ remain retained for at least 30 days.
- **Operational response**:
  1. Follow the procedure in [Worker dead-letter queues](worker-dead-letter-queues.md).
  2. Query Application Insights for the specific failing queue and oldest job timestamp:
     ```kusto
     traces
     | where timestamp > ago(30m)
     | where tostring(customDimensions.event) == "worker_dlq_depth"
     | extend queueName = tostring(customDimensions.queueName),
              depth = toint(customDimensions.depth),
              oldestCreatedOn = todatetime(customDimensions.oldestCreatedOn)
     | summarize arg_max(timestamp, *) by queueName
     | where depth > 0
     | project timestamp, queueName, depth, oldestCreatedOn
     ```
  3. Using authorized, read-only database access, inspect the DLQ records in `pgboss.job`:
     ```sql
     SELECT id, name, data, output, retrycount, created_on, keep_until
     FROM pgboss.job
     WHERE name = '<failing-queue-dlq>'
     ORDER BY created_on ASC
     LIMIT 10;
     ```
  4. Identify the root cause (e.g. invalid USFM structure, external API timeout, schema mismatch).
  5. After remediation, replay or resolve the jobs as described in the DLQ runbook.

### 3. DLQ monitor error

- **Rule name**: `fluent-${ENVIRONMENT}-worker-dlq-monitor-error`
- **Severity**: 2 (Warning)
- **Evaluation window**: 10 minutes, evaluated every 5 minutes
- **Trigger**: One or more `worker_dlq_monitor_error` events logged in the last 10 minutes.
- **KQL query**:
  ```kusto
  traces
  | where timestamp > ago(10m)
  | where tostring(customDimensions.event) == 'worker_dlq_monitor_error'
  | summarize count()
  ```
- **Context**: The worker periodically runs a dead-letter queue monitor sweep. If the query to PostgreSQL fails (timeout, permissions, or connection reset), it logs `worker_dlq_monitor_error`. A failed monitor sweep means dead-lettered jobs might exist without being visible in telemetry.
- **Operational response**:
  1. Query Application Insights for the exact error messages and affected queues:
     ```kusto
     traces
     | where timestamp > ago(1h)
     | where tostring(customDimensions.event) == "worker_dlq_monitor_error"
     | project timestamp, cloud_RoleInstance,
               queueName = tostring(customDimensions.queueName),
               error = tostring(customDimensions.error)
     | order by timestamp desc
     ```
  2. Verify that the database user has `SELECT` permissions on the `pgboss.job` table.
  3. Check database CPU, memory, and active connection pool usage for transient connection starvation.

### 4. Queue backlog growing

- **Rule name**: `fluent-${ENVIRONMENT}-worker-queue-backlog-growing`
- **Severity**: 2 (Warning)
- **Evaluation window**: 30 minutes, evaluated every 5 minutes
- **Trigger**: Over a 30-minute window, the latest queue size is larger than the earliest queue size, and the latest queue size exceeds 10 jobs.
- **KQL query**:
  ```kusto
  customMetrics
  | where timestamp > ago(30m)
  | where name == 'worker_queue_size'
  | extend workerInstance = tostring(cloud_RoleInstance)
  | sort by workerInstance asc, timestamp asc
  | summarize samples = make_list(value) by workerInstance
  | extend sampleCount = array_length(samples),
           earliestValue = todouble(samples[0]),
           latestValue = todouble(samples[array_length(samples) - 1])
  | where sampleCount >= 2 and latestValue > earliestValue and latestValue > 10
  ```
- **Context**: A sustained upward trend in total queued/active/deferred jobs across all queues suggests that work is arriving faster than the worker can process it, or that jobs are stalling.
- **Operational response**:
  1. Check currently active jobs across queues:
     ```kusto
     customMetrics
     | where timestamp > ago(1h)
     | where name == 'worker_active_jobs'
     | summarize avg(value) by bin(timestamp, 5m), tostring(customDimensions.queue)
     ```
  2. Check whether a burst of imports or exports was triggered (e.g., bulk USFM project materialization).
  3. Check average job duration in the worker heartbeat logs to see if jobs are running slower than normal.
  4. Check downstream service latency (e.g. Cloudflare R2 bucket transfers, external AI API latency).
  5. If the worker is healthy but processing capacity is saturated, consider scaling worker instances or concurrency.

### 5. Worker memory high

- **Rule name**: `fluent-${ENVIRONMENT}-worker-memory-high`
- **Severity**: 2 (Warning)
- **Evaluation window**: 15 minutes, evaluated every 5 minutes
- **Trigger**: The latest RSS sample from any worker instance exceeds 450 MB (or the environment-configured threshold).
- **KQL query**:
  ```kusto
  customMetrics
  | where timestamp > ago(15m)
  | where name == 'worker_rss_mb'
  | extend workerInstance = tostring(cloud_RoleInstance)
  | summarize arg_max(timestamp, *) by workerInstance
  | where value > 450
  ```
- **Context**: On an Azure App Service Basic B1 plan (512 MB total host memory), an RSS consumption of 450 MB represents ~80% utilization. If memory continues to grow, the container runtime will terminate the process with an OOM (Out Of Memory) kill.
- **Operational response**:
  1. Check heap vs RSS metrics over time:
     ```kusto
     customMetrics
     | where timestamp > ago(2h)
     | where name in ('worker_rss_mb', 'worker_heap_used_mb')
     | project timestamp, name, value
     | order by timestamp asc
     ```
  2. Identify which jobs were processed during the memory spike (e.g. exceptionally large USFM files or large AI batch requests).
  3. Check whether memory drops back down after job completion (Node.js garbage collection) or continues to climb monotonically (memory leak).
  4. If the normal workload genuinely requires more memory, upgrade the App Service plan (e.g., to B2 or P1v3) and adjust `--memory-threshold-mb` in the alert provisioning script.

---

## Provisioning alert rules

Alert rules are provisioned idempotently using `infra/alerts/provision-queue-alerts.sh`. Running the script creates new rules or updates existing rules in place.

### Prerequisites

1. Azure CLI (`az`) installed and authenticated (`az login`).
2. An existing Azure Monitor Action Group configured with appropriate notification targets (e.g., email, Teams webhook, Slack, or PagerDuty). The script accepts the Action Group resource ID as a parameter; notification destinations are never hardcoded.

### Script syntax

```bash
./infra/alerts/provision-queue-alerts.sh \
  --resource-group <resource-group-name> \
  --app-insights-id <app-insights-resource-id> \
  --action-group-id <action-group-resource-id> \
  --environment <dev|qa|prod> \
  [--memory-threshold-mb <mb>]
```

### Environment examples

#### Development (`dev`)

```bash
./infra/alerts/provision-queue-alerts.sh \
  --resource-group "rg-fluent-dev" \
  --app-insights-id "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-fluent-dev/providers/microsoft.insights/components/appi-fluent-dev" \
  --action-group-id "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-fluent-dev/providers/microsoft.insights/actionGroups/ag-fluent-dev-alerts" \
  --environment "dev"
```

#### Quality Assurance (`qa`)

```bash
./infra/alerts/provision-queue-alerts.sh \
  --resource-group "rg-fluent-qa" \
  --app-insights-id "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-fluent-qa/providers/microsoft.insights/components/appi-fluent-qa" \
  --action-group-id "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-fluent-qa/providers/microsoft.insights/actionGroups/ag-fluent-qa-alerts" \
  --environment "qa"
```

#### Production (`prod`)

```bash
./infra/alerts/provision-queue-alerts.sh \
  --resource-group "rg-fluent-prod" \
  --app-insights-id "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-fluent-prod/providers/microsoft.insights/components/appi-fluent-prod" \
  --action-group-id "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-fluent-prod/providers/microsoft.insights/actionGroups/ag-fluent-prod-alerts" \
  --environment "prod" \
  --memory-threshold-mb 450
```

---

## Ad-hoc KQL queries

Operators investigating queue performance or correlating system health should use the following KQL queries in Application Insights.

### a. Time-in-queue (enqueue → pickup)

This deployment does not emit a per-job enqueue/pickup telemetry pair, so queue-wait time cannot be derived truthfully in KQL yet. The metric below is a **backlog trend**, not time-in-queue; do not use it as a substitute. Until per-job timing telemetry is added, inspect the authoritative pg-boss timestamps with the fallback SQL query below.

```kusto
customMetrics
| where name == 'worker_queue_size'
| project timestamp, value
| order by timestamp asc
```

```sql
SELECT
  name AS queue_name,
  id,
  created_on AS enqueued_at,
  started_on AS picked_up_at,
  started_on - created_on AS time_in_queue
FROM pgboss.job
WHERE started_on IS NOT NULL
ORDER BY started_on DESC
LIMIT 100;
```

### b. API response time vs activeJobs correlation

Correlate API 95th-percentile response latency against active background worker load to detect resource contention between the API web server and background job processing:

```kusto
let queue_load = customMetrics
| where name == 'worker_active_jobs'
| summarize activeJobs=avg(value) by bin(timestamp, 5m);
let api_perf = requests
| summarize p95_duration=percentile(duration, 95) by bin(timestamp, 5m);
queue_load | join kind=inner api_perf on timestamp
| project timestamp, activeJobs, p95_duration
| order by timestamp asc
```

---

## Resource-scoped vs workspace-scoped column naming

Depending on how Application Insights is accessed, table and column names differ:

- **Resource-scoped view** (querying directly within the Application Insights resource in the Azure portal):
  - Metric table: `customMetrics`
  - Trace table: `traces`
  - Request table: `requests`
  - Timestamp column: `timestamp`
  - Custom properties: `customDimensions.<key>`
  - Role metadata: `cloud_RoleName`, `cloud_RoleInstance`

- **Workspace-scoped view** (querying via the linked Log Analytics workspace):
  - Metric table: `AppMetrics`
  - Trace table: `AppTraces`
  - Request table: `AppRequests`
  - Timestamp column: `TimeGenerated`
  - Custom properties: `Properties.<key>`
  - Role metadata: `AppRoleName`, `AppRoleInstance`

See the [Azure AppTraces table reference](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/apptraces) for full column mapping specifications.

---

## Job duration metrics policy

The worker emits `worker_avg_processing_seconds` as a custom metric on every heartbeat and retains `avgProcessingTimeSeconds` in the heartbeat log:

```text
scope=aggregate_all_queues, avgProcessingTimeSeconds=X, activeJobs=Y, processed=Z, failed=W
```

**Note**: Average job duration is charted in operational dashboards but is **deliberately not alerted** at this stage. Different queue workloads have fundamentally different baseline durations (e.g. quick single-verse AI suggestions take ~500ms, while whole-Bible USFM materialization and export operations can take tens of seconds). Establishing static duration thresholds prematurely creates false alerts. A duration alert will be configured once production distributions provide empirical thresholds per queue.
