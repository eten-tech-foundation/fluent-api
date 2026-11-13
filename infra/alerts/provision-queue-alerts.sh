#!/usr/bin/env bash
set -euo pipefail

# Provision Azure Monitor scheduled-query alert rules for worker queue monitoring.
# Creates or updates (idempotent) 5 scheduled query rules linked to the specified Action Group.

show_help() {
  cat <<'EOF'
Usage: provision-queue-alerts.sh [OPTIONS]

Required options:
  --resource-group, -g <name>     Azure Resource Group name
  --app-insights-id <resource-id> Full resource ID of Application Insights instance
  --action-group-id <resource-id> Full resource ID of Azure Monitor Action Group
  --environment, -e <env>         Target environment: dev, qa, or prod

Optional options:
  --memory-threshold-mb <mb>      Memory threshold in MB for worker RSS alert (default: 450)
  --help, -h                      Show this help message

Example:
  ./provision-queue-alerts.sh \
    --resource-group "rg-fluent-prod" \
    --app-insights-id "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-fluent-prod/providers/microsoft.insights/components/appi-fluent-prod" \
    --action-group-id "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-fluent-prod/providers/microsoft.insights/actionGroups/ag-fluent-ops" \
    --environment "prod"
EOF
}

RESOURCE_GROUP=""
APP_INSIGHTS_ID=""
ACTION_GROUP_ID=""
ENVIRONMENT=""
MEMORY_THRESHOLD_MB=450

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group=*)
      RESOURCE_GROUP="${1#*=}"
      shift
      ;;
    --resource-group|-g)
      RESOURCE_GROUP="${2:-}"
      shift 2
      ;;
    --app-insights-id=*)
      APP_INSIGHTS_ID="${1#*=}"
      shift
      ;;
    --app-insights-id)
      APP_INSIGHTS_ID="${2:-}"
      shift 2
      ;;
    --action-group-id=*)
      ACTION_GROUP_ID="${1#*=}"
      shift
      ;;
    --action-group-id)
      ACTION_GROUP_ID="${2:-}"
      shift 2
      ;;
    --environment=*)
      ENVIRONMENT="${1#*=}"
      shift
      ;;
    --environment|-e)
      ENVIRONMENT="${2:-}"
      shift 2
      ;;
    --memory-threshold-mb=*)
      MEMORY_THRESHOLD_MB="${1#*=}"
      shift
      ;;
    --memory-threshold-mb)
      MEMORY_THRESHOLD_MB="${2:-}"
      shift 2
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      show_help
      exit 1
      ;;
  esac
done

# Validate required arguments
missing=()
[[ -z "$RESOURCE_GROUP" ]] && missing+=("--resource-group")
[[ -z "$APP_INSIGHTS_ID" ]] && missing+=("--app-insights-id")
[[ -z "$ACTION_GROUP_ID" ]] && missing+=("--action-group-id")
[[ -z "$ENVIRONMENT" ]] && missing+=("--environment")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Error: Missing required argument(s): ${missing[*]}" >&2
  show_help
  exit 1
fi

case "$ENVIRONMENT" in
  dev|qa|prod)
    ;;
  *)
    echo "Error: Invalid --environment '${ENVIRONMENT}'. Allowed values: dev, qa, prod." >&2
    exit 1
    ;;
esac

if ! [[ "$MEMORY_THRESHOLD_MB" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Error: --memory-threshold-mb must be a non-negative number." >&2
  exit 1
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Error: Azure CLI ('az') is not installed or not in PATH." >&2
  exit 1
fi

echo "================================================================"
echo "Provisioning Azure Monitor Queue Alert Rules"
echo "  Environment:       ${ENVIRONMENT}"
echo "  Resource Group:    ${RESOURCE_GROUP}"
echo "  App Insights ID:   ${APP_INSIGHTS_ID}"
echo "  Action Group ID:   ${ACTION_GROUP_ID}"
echo "  Memory Threshold:  ${MEMORY_THRESHOLD_MB} MB"
echo "================================================================"

# Rule 1: Worker heartbeat missing (Severity 0 / Critical, 15 min window)
RULE_1_NAME="fluent-${ENVIRONMENT}-worker-heartbeat-missing"
RULE_1_KQL="customMetrics | where timestamp > ago(15m) | where name == 'worker_rss_mb' | summarize samples = count() | where samples == 0"

echo "[1/5] Provisioning Rule 1: ${RULE_1_NAME}..."
az monitor scheduled-query create \
  --name "${RULE_1_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --scopes "${APP_INSIGHTS_ID}" \
  --condition "count 'heartbeat_missing' > 0" \
  --condition-query heartbeat_missing="${RULE_1_KQL}" \
  --action-groups "${ACTION_GROUP_ID}" \
  --severity 0 \
  --evaluation-frequency "5m" \
  --window-size "15m" \
  --description "Worker heartbeat missing: no worker_rss_mb heartbeat metric received for 15 minutes (worker may be stopped, crashed, or hung)."

# Rule 2: DLQ depth > 0 (Severity 2 / Warning, 10 min window)
RULE_2_NAME="fluent-${ENVIRONMENT}-worker-dlq-depth"
RULE_2_KQL="customMetrics | where timestamp > ago(10m) | where name == 'worker_dlq_depth' | extend queueName = tostring(customDimensions.queueName), workerInstance = tostring(cloud_RoleInstance) | summarize arg_max(timestamp, *) by workerInstance, queueName | where value > 0"

echo "[2/5] Provisioning Rule 2: ${RULE_2_NAME}..."
az monitor scheduled-query create \
  --name "${RULE_2_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --scopes "${APP_INSIGHTS_ID}" \
  --condition "count 'dlq_depth' > 0" \
  --condition-query dlq_depth="${RULE_2_KQL}" \
  --action-groups "${ACTION_GROUP_ID}" \
  --severity 2 \
  --evaluation-frequency "5m" \
  --window-size "10m" \
  --description "DLQ depth > 0: dead-letter queue contains retained failed jobs requiring operator inspection."

# Rule 3: DLQ monitor error (Severity 2 / Warning, 10 min window)
RULE_3_NAME="fluent-${ENVIRONMENT}-worker-dlq-monitor-error"
RULE_3_KQL="traces | where timestamp > ago(10m) | where tostring(customDimensions.event) == 'worker_dlq_monitor_error' | summarize errorCount = count() | where errorCount > 0"

echo "[3/5] Provisioning Rule 3: ${RULE_3_NAME}..."
az monitor scheduled-query create \
  --name "${RULE_3_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --scopes "${APP_INSIGHTS_ID}" \
  --condition "count 'dlq_monitor_error' > 0" \
  --condition-query dlq_monitor_error="${RULE_3_KQL}" \
  --action-groups "${ACTION_GROUP_ID}" \
  --severity 2 \
  --evaluation-frequency "5m" \
  --window-size "10m" \
  --description "DLQ monitor error: the API server failed to sweep dead-letter queues (missing telemetry could mask failures)."

# Rule 4: Queue backlog growing (Severity 2 / Warning, 30 min window)
RULE_4_NAME="fluent-${ENVIRONMENT}-worker-queue-backlog-growing"
RULE_4_KQL="customMetrics | where timestamp > ago(30m) | where name == 'worker_queue_size' | extend workerInstance = tostring(cloud_RoleInstance) | summarize sampleCount = count(), earliest = arg_min(timestamp, value), latest = arg_max(timestamp, value) by workerInstance | extend earliestValue = todouble(earliest_value), latestValue = todouble(latest_value) | where sampleCount >= 2 and latestValue > earliestValue and latestValue > 10"

echo "[4/5] Provisioning Rule 4: ${RULE_4_NAME}..."
az monitor scheduled-query create \
  --name "${RULE_4_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --scopes "${APP_INSIGHTS_ID}" \
  --condition "count 'queue_backlog_growing' > 0" \
  --condition-query queue_backlog_growing="${RULE_4_KQL}" \
  --action-groups "${ACTION_GROUP_ID}" \
  --severity 2 \
  --evaluation-frequency "5m" \
  --window-size "30m" \
  --description "Queue backlog growing: worker queue size has increased over the last 30 minutes and exceeds 10 jobs."

# Rule 5: Worker memory high (Severity 2 / Warning, 15 min window)
RULE_5_NAME="fluent-${ENVIRONMENT}-worker-memory-high"
RULE_5_KQL="customMetrics | where timestamp > ago(15m) | where name == 'worker_rss_mb' | extend workerInstance = tostring(cloud_RoleInstance) | summarize arg_max(timestamp, *) by workerInstance | where value > ${MEMORY_THRESHOLD_MB}"

echo "[5/5] Provisioning Rule 5: ${RULE_5_NAME}..."
az monitor scheduled-query create \
  --name "${RULE_5_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --scopes "${APP_INSIGHTS_ID}" \
  --condition "count 'worker_memory_high' > 0" \
  --condition-query worker_memory_high="${RULE_5_KQL}" \
  --action-groups "${ACTION_GROUP_ID}" \
  --severity 2 \
  --evaluation-frequency "5m" \
  --window-size "15m" \
  --description "Worker memory high: the latest RSS memory sample exceeded ${MEMORY_THRESHOLD_MB} MB (worker process ceiling on shared App Service plan)."

echo ""
echo "Successfully provisioned all 5 Azure Monitor queue alert rules for '${ENVIRONMENT}'."
