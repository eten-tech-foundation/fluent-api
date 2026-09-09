import type { PgBoss, Queue } from 'pg-boss';

import { logger } from '@/lib/logger';

/** Time to investigate new DLQ entries before pg-boss maintenance removes them. */
export const DLQ_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** Create a durable diagnostic destination before enabling dead-letter routing. */
export async function ensureWorkerQueue(
  boss: PgBoss,
  name: string,
  options: Omit<Queue, 'name' | 'deadLetter'> = {}
): Promise<void> {
  const deadLetter = `${name}-dlq`;
  const existing = await boss.getQueue(deadLetter);
  const retentionOptions = {
    // Do not shorten an operator's longer retention policy. Queue updates only
    // affect new jobs; existing keep_until/deletion_seconds remain untouched.
    retentionSeconds: Math.max(existing?.retentionSeconds ?? 0, DLQ_RETENTION_SECONDS),
    deleteAfterSeconds: Math.max(existing?.deleteAfterSeconds ?? 0, DLQ_RETENTION_SECONDS),
  };
  // pg-boss mutates createQueue options (including adding an immutable policy).
  // Do not pass that mutated object back into updateQueue.
  await boss.createQueue(deadLetter, { ...retentionOptions });
  await boss.updateQueue(deadLetter, retentionOptions);

  await boss.createQueue(name, { ...options, deadLetter });
  // createQueue is a no-op for existing queues. Reconcile mutable settings
  // without deleting any queue or modifying jobs that have already been sent.
  const { policy: _policy, partition: _partition, ...mutableOptions } = options;
  await boss.updateQueue(name, { ...mutableOptions, deadLetter });
}

/** Report retained DLQ rows without fetching, acknowledging or replaying them. */
export async function reportDeadLetterQueues(boss: PgBoss): Promise<void> {
  try {
    const queues = await boss.getQueues();
    // Discover configured targets, including custom names, and orphaned/legacy
    // *-dlq queues. A worker added later is picked up on the next sweep.
    const targets = new Set<string>();
    for (const queue of queues) {
      if (queue.deadLetter) targets.add(queue.deadLetter);
      if (queue.name.endsWith('-dlq')) targets.add(queue.name);
    }

    for (const queueName of targets) {
      try {
        // pg-boss 12.1.1 getQueueStats falls back to cached counters when a
        // queue becomes empty. Read an aggregate without GROUP BY so a cleared
        // queue always reports zero. The parent job table includes partitions.
        const { rows } = await boss.getDb().executeSql(
          `SELECT count(*)::int AS depth,
                  count(*) FILTER (WHERE state < 'active')::int AS "queuedCount",
                  count(*) FILTER (WHERE state = 'active')::int AS "activeCount",
                  count(*) FILTER (WHERE start_after > now())::int AS "deferredCount",
                  min(created_on) AS "oldestCreatedOn"
             FROM pgboss.job WHERE name = $1`,
          [queueName]
        );
        const stats = rows[0];
        const properties = {
          event: 'worker_dlq_depth',
          queueName,
          depth: stats.depth,
          queuedCount: stats.queuedCount,
          activeCount: stats.activeCount,
          deferredCount: stats.deferredCount,
          oldestCreatedOn: stats.oldestCreatedOn?.toISOString() ?? null,
        };
        // Object first keeps dimensions queryable in both Pino and App Insights.
        // Count rows once: deferred jobs are also queued.
        if (properties.depth > 0) {
          logger.warn(properties, 'Worker dead-letter queue contains jobs');
        } else {
          logger.info(properties, 'Worker dead-letter queue is empty');
        }
      } catch (error) {
        logger.error(
          {
            event: 'worker_dlq_monitor_error',
            queueName,
            error: error instanceof Error ? error.message : String(error),
          },
          'Worker dead-letter queue inspection failed'
        );
      }
    }
  } catch (error) {
    logger.error(
      {
        event: 'worker_dlq_monitor_error',
        error: error instanceof Error ? error.message : String(error),
      },
      'Worker dead-letter queue discovery failed'
    );
  }
}

/** Start on API boot so monitoring survives an export worker's R2 boot failure. */
export function startDeadLetterMonitor(boss: PgBoss): () => Promise<void> {
  let running: Promise<void> | undefined;
  const sweep = () => {
    if (running) return;
    running = reportDeadLetterQueues(boss).finally(() => {
      running = undefined;
    });
  };
  sweep();
  const interval = setInterval(sweep, 60_000);
  interval.unref();

  return async () => {
    clearInterval(interval);
    await running;
  };
}
