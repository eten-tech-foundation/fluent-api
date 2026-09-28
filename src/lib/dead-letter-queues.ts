import type { PgBoss, Queue } from 'pg-boss';

import { logger } from '@/lib/logger';
import { PG_BOSS_SCHEMA_VERSION } from '@/lib/pg-boss-schema';

/** Time to investigate new DLQ entries before pg-boss maintenance removes them. */
export const DLQ_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const DLQ_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEAD_LETTER_SUFFIX = '-dlq';

/** Default dead-letter destination for a source without custom routing. */
export function deadLetterQueueName(name: string): string {
  return `${name}${DEAD_LETTER_SUFFIX}`;
}

function queueMatchesOptions(queue: Queue, options: Partial<Queue>): boolean {
  const current = queue as unknown as Record<string, unknown>;
  return Object.entries(options).every(([key, value]) => current[key] === value);
}

/** Create a durable diagnostic destination before enabling dead-letter routing. */
export async function ensureWorkerQueue(
  boss: PgBoss,
  name: string,
  options: Omit<Queue, 'name' | 'deadLetter'> = {}
): Promise<void> {
  const source = await boss.getQueue(name);
  const deadLetter = source?.deadLetter ?? deadLetterQueueName(name);
  const existing = await boss.getQueue(deadLetter);
  const retentionOptions = {
    // Do not shorten an operator's longer retention policy. Queue updates only
    // affect new jobs; existing keep_until/deletion_seconds remain untouched.
    retentionSeconds: Math.max(existing?.retentionSeconds ?? 0, DLQ_RETENTION_SECONDS),
    deleteAfterSeconds: Math.max(existing?.deleteAfterSeconds ?? 0, DLQ_RETENTION_SECONDS),
  };
  if (existing) {
    if (!queueMatchesOptions(existing, retentionOptions)) {
      await boss.updateQueue(deadLetter, retentionOptions);
    }
  } else {
    await boss.createQueue(deadLetter, retentionOptions);
  }

  if (!source) {
    await boss.createQueue(name, { ...options, deadLetter });
    return;
  }
  if (options.policy && source.policy !== options.policy) {
    logger.warn(
      {
        event: 'worker_queue_policy_mismatch',
        queueName: name,
        previousPolicy: source.policy,
        expectedPolicy: options.policy,
      },
      'Worker queue policy differs; run the explicit worker queue policy migration'
    );
  }
  // Policy and partition are immutable in pg-boss. Preserve existing jobs.
  const { policy: _policy, partition: _partition, ...mutableOptions } = options;
  const desiredOptions = { ...mutableOptions, deadLetter };
  if (!queueMatchesOptions(source, desiredOptions)) {
    await boss.updateQueue(name, desiredOptions);
  }
}

/** Report retained DLQ rows without fetching, acknowledging or replaying them. */
export async function reportDeadLetterQueues(boss: PgBoss): Promise<void> {
  try {
    const database = boss.getDb();
    const { rows: schemaRows } = await database.executeSql('SELECT version FROM pgboss.version');
    const schemaVersion = schemaRows[0]?.version;
    if (schemaVersion !== PG_BOSS_SCHEMA_VERSION) {
      logger.error(
        {
          event: 'worker_dlq_monitor_schema_mismatch',
          expectedSchemaVersion: PG_BOSS_SCHEMA_VERSION,
          actualSchemaVersion: schemaVersion ?? null,
        },
        `Worker dead-letter queue monitoring requires pg-boss schema version ${PG_BOSS_SCHEMA_VERSION}`
      );
      return;
    }

    const queues = await boss.getQueues();
    // Discover configured targets, including custom names, and orphaned/legacy
    // *-dlq queues. A worker added later is picked up on the next sweep.
    const targets = new Set<string>();
    for (const queue of queues) {
      if (queue.deadLetter) targets.add(queue.deadLetter);
      if (queue.name.endsWith(DEAD_LETTER_SUFFIX)) targets.add(queue.name);
    }

    await Promise.allSettled(
      [...targets].map(async (queueName) => {
        try {
          // pg-boss 12.1.1 getQueueStats falls back to cached counters when a
          // queue becomes empty. Read an aggregate without GROUP BY so a cleared
          // queue always reports zero. The parent job table includes partitions.
          const { rows } = await database.executeSql(
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
      })
    );
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
    if (!running) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            logger.warn(
              { event: 'worker_dlq_monitor_shutdown_timeout', timeoutMs: DLQ_SHUTDOWN_TIMEOUT_MS },
              'Continuing shutdown while a dead-letter queue inspection is still pending'
            );
            resolve();
          }, DLQ_SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
}
