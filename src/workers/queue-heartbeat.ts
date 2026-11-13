import type { PgBoss } from 'pg-boss';

import { logger } from '@/lib/logger';
import { QUEUE_NAMES } from '@/lib/queue';

/** Count pending rows once, including delayed retries, using the configured pg-boss schema. */
export async function countPendingQueueJobs(boss: PgBoss, queueName: string): Promise<number> {
  // pg-boss 12.1.1 getQueueStats can retain cached counters when its grouped query
  // returns no rows. An aggregate without GROUP BY always reports zero after drain.
  const { rows } = await boss.getDb().executeSql(
    `SELECT count(*)::int AS count FROM pgboss.job
     WHERE name = $1 AND state IN ('created', 'retry', 'active')`,
    [queueName]
  );
  return rows[0].count;
}

export interface WorkerMetricsSnapshot {
  startTime: number;
  jobsProcessed: number;
  jobsFailed: number;
  totalProcessingTime: number;
  activeJobs: number;
}

const MONITORED_QUEUES = [
  QUEUE_NAMES.USFM_EXPORT,
  QUEUE_NAMES.AI_SUGGESTIONS,
  QUEUE_NAMES.DBL_INGEST_TEXT,
  QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY,
  QUEUE_NAMES.USFM_IMPORT_MATERIALIZE,
] as const;

export async function emitHeartbeatMetrics(
  boss: PgBoss,
  metrics: WorkerMetricsSnapshot
): Promise<void> {
  const uptimeSeconds = (Date.now() - metrics.startTime) / 1000;
  const completedAttempts = metrics.jobsProcessed + metrics.jobsFailed;
  const avgProcessingTimeMs =
    completedAttempts > 0 ? metrics.totalProcessingTime / completedAttempts : 0;
  const avgProcessingTimeSeconds = Number((avgProcessingTimeMs / 1000).toFixed(2));

  const memory = process.memoryUsage();
  const rssMb = Math.round(memory.rss / 1024 / 1024);
  const heapUsedMb = Math.round(memory.heapUsed / 1024 / 1024);

  // Emit process-level vitals unconditionally so worker liveness and memory alerts
  // remain active even if database queue queries fail.
  logger.metric('worker_rss_mb', rssMb);
  logger.metric('worker_heap_used_mb', heapUsedMb);
  logger.metric('worker_active_jobs', metrics.activeJobs);
  logger.metric('worker_jobs_processed_total', metrics.jobsProcessed);
  logger.metric('worker_jobs_failed_total', metrics.jobsFailed);
  logger.metric('worker_avg_processing_seconds', avgProcessingTimeSeconds);

  let queueSize: number | null = null;
  try {
    // Read live pending rows for all 5 queues via countPendingQueueJobs.
    // This avoids pg-boss 12.1.1's getQueueStats cached-counter bug on drained queues
    // and ensures deferred jobs are counted once (state IN ('created', 'retry', 'active')).
    const queueCounts = await Promise.all(
      MONITORED_QUEUES.map(async (queueName) => {
        const count = await countPendingQueueJobs(boss, queueName);
        return [queueName, count] as const;
      })
    );

    let total = 0;
    for (const [queueName, count] of queueCounts) {
      total += count;
      logger.metric('worker_queue_size_per_queue', count, { queue: queueName });
    }
    queueSize = total;
    logger.metric('worker_queue_size', queueSize);
  } catch (error) {
    logger.error(
      {
        event: 'worker_heartbeat_queue_error',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error in heartbeat queue inspection'
    );
  }

  // The 'Worker heartbeat' log trace is emitted on every heartbeat, providing
  // a reliable process liveness trace for deploy verification even if database
  // queue reads temporarily fail.
  logger.info('Worker heartbeat', {
    scope: 'aggregate_all_queues',
    uptimeSeconds: Math.floor(uptimeSeconds),
    activeJobs: metrics.activeJobs,
    processed: metrics.jobsProcessed,
    failed: metrics.jobsFailed,
    avgProcessingTimeSeconds,
    queueSize,
    memory: {
      rssMb,
      heapUsedMb,
    },
  });
}
