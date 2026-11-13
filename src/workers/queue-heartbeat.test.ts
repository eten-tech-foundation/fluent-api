import type { PgBoss } from 'pg-boss';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logger';
import { QUEUE_NAMES } from '@/lib/queue';
import { fakeBoss } from '@/test/utils/test-helpers';

import type { WorkerMetricsSnapshot } from './queue-heartbeat';

import { countPendingQueueJobs, emitHeartbeatMetrics } from './queue-heartbeat';

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    metric: vi.fn(),
  },
}));

describe('uSFM materialization heartbeat count', () => {
  const db = new PGlite();
  beforeAll(async () => {
    await db.exec(`CREATE SCHEMA pgboss;
      CREATE TYPE pgboss.job_state AS ENUM ('created', 'retry', 'active', 'completed', 'cancelled', 'failed');
      CREATE TABLE pgboss.job (name text, state pgboss.job_state, start_after timestamptz DEFAULT now());`);
  });
  afterAll(async () => db.close());

  it('counts live pending rows once and returns zero after the queue drains despite stale cached counters', async () => {
    const boss = {
      getQueueStats: vi
        .fn()
        .mockResolvedValue({ queuedCount: 9, activeCount: 8, deferredCount: 7 }),
      getDb: () => ({ executeSql: (sql: string, values: unknown[]) => db.query(sql, values) }),
    } as unknown as PgBoss;
    await db.exec(`INSERT INTO pgboss.job (name, state, start_after) VALUES
      ('usfm-import-materialize', 'created', now()),
      ('usfm-import-materialize', 'retry', now() + interval '1 hour'),
      ('usfm-import-materialize', 'active', now()),
      ('usfm-import-materialize', 'completed', now()),
      ('usfm-import-materialize', 'cancelled', now()),
      ('usfm-import-materialize', 'failed', now()),
      ('other', 'created', now());`);
    expect(await countPendingQueueJobs(boss, 'usfm-import-materialize')).toBe(3);
    await db.exec("DELETE FROM pgboss.job WHERE name = 'usfm-import-materialize'");
    expect(await countPendingQueueJobs(boss, 'usfm-import-materialize')).toBe(0);
    expect(boss.getQueueStats).not.toHaveBeenCalled();
  });
});

describe('emitHeartbeatMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseMetrics: WorkerMetricsSnapshot = {
    startTime: Date.now() - 300_000,
    jobsProcessed: 10,
    jobsFailed: 2,
    totalProcessingTime: 25_000,
    activeJobs: 3,
  };

  it('emits all aggregate metrics and per-queue backlog metrics with stubbed queue counts', async () => {
    const { boss, executeSql } = fakeBoss();
    executeSql.mockImplementation(async (query, values) => {
      const queueName = values?.[0];
      switch (queueName) {
        case QUEUE_NAMES.USFM_EXPORT:
          return { rows: [{ count: 3 }] };
        case QUEUE_NAMES.AI_SUGGESTIONS:
          return { rows: [{ count: 4 }] };
        case QUEUE_NAMES.DBL_INGEST_TEXT:
          return { rows: [{ count: 3 }] };
        case QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY:
          return { rows: [{ count: 1 }] };
        case QUEUE_NAMES.USFM_IMPORT_MATERIALIZE:
          return { rows: [{ count: 5 }] };
        default:
          return { rows: [{ count: 0 }] };
      }
    });

    await emitHeartbeatMetrics(boss, baseMetrics);

    // Total queueSize = 3 + 4 + 3 + 1 + 5 = 16
    // completedAttempts = 10 + 2 = 12
    // avgProcessingTime = 25000 / 12 / 1000 = 2.08s

    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size', 16);
    expect(logger.metric).toHaveBeenCalledWith('worker_active_jobs', 3);
    expect(logger.metric).toHaveBeenCalledWith('worker_jobs_processed_total', 10);
    expect(logger.metric).toHaveBeenCalledWith('worker_jobs_failed_total', 2);
    expect(logger.metric).toHaveBeenCalledWith('worker_avg_processing_seconds', 2.08);
    expect(logger.metric).toHaveBeenCalledWith('worker_rss_mb', expect.any(Number));
    expect(logger.metric).toHaveBeenCalledWith('worker_heap_used_mb', expect.any(Number));

    // Per-queue backlog
    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size_per_queue', 3, {
      queue: QUEUE_NAMES.USFM_EXPORT,
    });
    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size_per_queue', 4, {
      queue: QUEUE_NAMES.AI_SUGGESTIONS,
    });
    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size_per_queue', 3, {
      queue: QUEUE_NAMES.DBL_INGEST_TEXT,
    });
    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size_per_queue', 1, {
      queue: QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY,
    });
    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size_per_queue', 5, {
      queue: QUEUE_NAMES.USFM_IMPORT_MATERIALIZE,
    });
  });

  it('asserts the Worker heartbeat log line is still emitted with the same shape', async () => {
    const { boss, executeSql } = fakeBoss();
    executeSql.mockImplementation(async () => {
      return { rows: [{ count: 2 }] };
    });

    await emitHeartbeatMetrics(boss, baseMetrics);

    // 5 queues * 2 = 10
    expect(logger.info).toHaveBeenCalledWith('Worker heartbeat', {
      scope: 'aggregate_all_queues',
      uptimeSeconds: expect.any(Number),
      activeJobs: 3,
      processed: 10,
      failed: 2,
      avgProcessingTimeSeconds: 2.08,
      queueSize: 10,
      memory: {
        rssMb: expect.any(Number),
        heapUsedMb: expect.any(Number),
      },
    });
  });

  it('asserts per-queue dimensions on worker_queue_size_per_queue for each of the 5 queues', async () => {
    const { boss, executeSql } = fakeBoss();
    executeSql.mockImplementation(async (query, values) => {
      const queueName = values?.[0];
      const counts: Record<string, number> = {
        [QUEUE_NAMES.USFM_EXPORT]: 10,
        [QUEUE_NAMES.AI_SUGGESTIONS]: 20,
        [QUEUE_NAMES.DBL_INGEST_TEXT]: 30,
        [QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY]: 40,
        [QUEUE_NAMES.USFM_IMPORT_MATERIALIZE]: 9,
      };
      return { rows: [{ count: counts[queueName as string] ?? 0 }] };
    });

    await emitHeartbeatMetrics(boss, baseMetrics);

    const perQueueCalls = vi
      .mocked(logger.metric)
      .mock.calls.filter((args) => args[0] === 'worker_queue_size_per_queue');
    expect(perQueueCalls).toEqual([
      ['worker_queue_size_per_queue', 10, { queue: 'usfm-export' }],
      ['worker_queue_size_per_queue', 20, { queue: 'ai-suggestions' }],
      ['worker_queue_size_per_queue', 30, { queue: 'dbl-ingest-text' }],
      ['worker_queue_size_per_queue', 40, { queue: 'dbl-ingest-text-priority' }],
      ['worker_queue_size_per_queue', 9, { queue: 'usfm-import-materialize' }],
    ]);
  });

  it('handles zero queue counts gracefully without throwing', async () => {
    const { boss, executeSql } = fakeBoss();
    executeSql.mockResolvedValue({ rows: [{ count: 0 }] });

    await emitHeartbeatMetrics(boss, {
      ...baseMetrics,
      jobsProcessed: 0,
      jobsFailed: 0,
      totalProcessingTime: 0,
    });

    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size', 0);
    expect(logger.metric).toHaveBeenCalledWith('worker_avg_processing_seconds', 0);
    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size_per_queue', 0, {
      queue: QUEUE_NAMES.USFM_EXPORT,
    });
  });

  it('on countPendingQueueJobs error, emits process vitals and liveness trace, but no queue metrics, and logs error', async () => {
    const { boss, executeSql } = fakeBoss();
    const dbError = new Error('Database query execution error');
    executeSql.mockRejectedValue(dbError);

    await emitHeartbeatMetrics(boss, baseMetrics);

    // Process-level vitals are still emitted
    expect(logger.metric).toHaveBeenCalledWith('worker_rss_mb', expect.any(Number));
    expect(logger.metric).toHaveBeenCalledWith('worker_heap_used_mb', expect.any(Number));
    expect(logger.metric).toHaveBeenCalledWith('worker_active_jobs', 3);
    expect(logger.metric).toHaveBeenCalledWith('worker_jobs_processed_total', 10);
    expect(logger.metric).toHaveBeenCalledWith('worker_jobs_failed_total', 2);
    expect(logger.metric).toHaveBeenCalledWith('worker_avg_processing_seconds', 2.08);

    // Queue-level metrics are NOT emitted on DB failure
    expect(logger.metric).not.toHaveBeenCalledWith('worker_queue_size', expect.anything());
    expect(logger.metric).not.toHaveBeenCalledWith(
      'worker_queue_size_per_queue',
      expect.anything(),
      expect.anything()
    );

    // 'Worker heartbeat' trace IS still emitted with queueSize: null for deploy verification
    expect(logger.info).toHaveBeenCalledWith(
      'Worker heartbeat',
      expect.objectContaining({
        scope: 'aggregate_all_queues',
        queueSize: null,
      })
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'worker_heartbeat_queue_error',
        error: dbError.message,
      }),
      'Error in heartbeat queue inspection'
    );
  });
});
