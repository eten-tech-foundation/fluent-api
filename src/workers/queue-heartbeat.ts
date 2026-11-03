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

export async function emitHeartbeatMetrics(
  boss: PgBoss,
  metrics: WorkerMetricsSnapshot
): Promise<void> {
  try {
    const uptimeSeconds = (Date.now() - metrics.startTime) / 1000;
    const avgProcessingTimeMs =
      metrics.jobsProcessed > 0 ? metrics.totalProcessingTime / metrics.jobsProcessed : 0;

    // These independent reads are sampled as one heartbeat. Running them concurrently
    // keeps a slow queue-stat query from delaying the entire sample interval.
    const [exportStats, aiStats, ingestStats, ingestPriorityStats, importMaterializeCount] =
      await Promise.all([
        boss.getQueueStats(QUEUE_NAMES.USFM_EXPORT),
        boss.getQueueStats(QUEUE_NAMES.AI_SUGGESTIONS),
        boss.getQueueStats(QUEUE_NAMES.DBL_INGEST_TEXT),
        boss.getQueueStats(QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY),
        countPendingQueueJobs(boss, QUEUE_NAMES.USFM_IMPORT_MATERIALIZE),
      ]);

    const exportQueueSize =
      (exportStats?.queuedCount || 0) +
      (exportStats?.activeCount || 0) +
      (exportStats?.deferredCount || 0);
    const aiQueueSize =
      (aiStats?.queuedCount || 0) + (aiStats?.activeCount || 0) + (aiStats?.deferredCount || 0);
    const ingestQueueSize =
      (ingestStats?.queuedCount || 0) +
      (ingestStats?.activeCount || 0) +
      (ingestStats?.deferredCount || 0);
    const ingestPriorityQueueSize =
      (ingestPriorityStats?.queuedCount || 0) +
      (ingestPriorityStats?.activeCount || 0) +
      (ingestPriorityStats?.deferredCount || 0);

    const totalQueued =
      (exportStats?.queuedCount || 0) +
      (aiStats?.queuedCount || 0) +
      (ingestStats?.queuedCount || 0) +
      (ingestPriorityStats?.queuedCount || 0);

    const totalActive =
      (exportStats?.activeCount || 0) +
      (aiStats?.activeCount || 0) +
      (ingestStats?.activeCount || 0) +
      (ingestPriorityStats?.activeCount || 0);

    const totalDeferred =
      (exportStats?.deferredCount || 0) +
      (aiStats?.deferredCount || 0) +
      (ingestStats?.deferredCount || 0) +
      (ingestPriorityStats?.deferredCount || 0);

    const queueSize = totalQueued + totalActive + totalDeferred + importMaterializeCount;

    const avgProcessingTimeSeconds = Number((avgProcessingTimeMs / 1000).toFixed(2));
    const memory = process.memoryUsage();
    const rssMb = Math.round(memory.rss / 1024 / 1024);
    const heapUsedMb = Math.round(memory.heapUsed / 1024 / 1024);

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

    logger.metric('worker_queue_size', queueSize);
    logger.metric('worker_active_jobs', metrics.activeJobs);
    logger.metric('worker_jobs_processed_total', metrics.jobsProcessed);
    logger.metric('worker_jobs_failed_total', metrics.jobsFailed);
    logger.metric('worker_avg_processing_seconds', avgProcessingTimeSeconds);
    logger.metric('worker_rss_mb', rssMb);
    logger.metric('worker_heap_used_mb', heapUsedMb);

    logger.metric('worker_queue_size_per_queue', exportQueueSize, {
      queue: QUEUE_NAMES.USFM_EXPORT,
    });
    logger.metric('worker_queue_size_per_queue', aiQueueSize, {
      queue: QUEUE_NAMES.AI_SUGGESTIONS,
    });
    logger.metric('worker_queue_size_per_queue', ingestQueueSize, {
      queue: QUEUE_NAMES.DBL_INGEST_TEXT,
    });
    logger.metric('worker_queue_size_per_queue', ingestPriorityQueueSize, {
      queue: QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY,
    });
    logger.metric('worker_queue_size_per_queue', importMaterializeCount, {
      queue: QUEUE_NAMES.USFM_IMPORT_MATERIALIZE,
    });
  } catch (error) {
    logger.error('Error in heartbeat', { error });
  }
}
