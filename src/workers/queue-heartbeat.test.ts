import type { PgBoss, QueueResult } from 'pg-boss';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logger';
import { QUEUE_NAMES } from '@/lib/queue';
import { fakeBoss, queueResult } from '@/test/utils/test-helpers';

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

  it('emits all aggregate metrics and per-queue backlog metrics with stubbed queue stats', async () => {
    const { boss, executeSql } = fakeBoss();
    executeSql.mockImplementation(async (query) => {
      if (typeof query === 'string' && query.includes('count(*)::int AS count')) {
        return { rows: [{ count: 5 }] };
      }
      return { rows: [] };
    });

    vi.spyOn(boss, 'getQueueStats').mockImplementation(async (queueName) => {
      switch (queueName) {
        case QUEUE_NAMES.USFM_EXPORT:
          return queueResult(queueName, { queuedCount: 1, activeCount: 2, deferredCount: 3 });
        case QUEUE_NAMES.AI_SUGGESTIONS:
          return queueResult(queueName, { queuedCount: 4, activeCount: 0, deferredCount: 1 });
        case QUEUE_NAMES.DBL_INGEST_TEXT:
          return queueResult(queueName, { queuedCount: 2, activeCount: 1, deferredCount: 0 });
        case QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY:
          return queueResult(queueName, { queuedCount: 0, activeCount: 1, deferredCount: 0 });
        default:
          return null as unknown as QueueResult;
      }
    });

    await emitHeartbeatMetrics(boss, baseMetrics);

    // USFM_EXPORT: 1 + 2 + 3 = 6
    // AI_SUGGESTIONS: 4 + 0 + 1 = 5
    // DBL_INGEST_TEXT: 2 + 1 + 0 = 3
    // DBL_INGEST_TEXT_PRIORITY: 0 + 1 + 0 = 1
    // USFM_IMPORT_MATERIALIZE: 5
    // Total queueSize = 6 + 5 + 3 + 1 + 5 = 20

    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size', 20);
    expect(logger.metric).toHaveBeenCalledWith('worker_active_jobs', 3);
    expect(logger.metric).toHaveBeenCalledWith('worker_jobs_processed_total', 10);
    expect(logger.metric).toHaveBeenCalledWith('worker_jobs_failed_total', 2);
    expect(logger.metric).toHaveBeenCalledWith('worker_avg_processing_seconds', 2.5);
    expect(logger.metric).toHaveBeenCalledWith('worker_rss_mb', expect.any(Number));
    expect(logger.metric).toHaveBeenCalledWith('worker_heap_used_mb', expect.any(Number));

    // Per-queue backlog
    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size_per_queue', 6, {
      queue: QUEUE_NAMES.USFM_EXPORT,
    });
    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size_per_queue', 5, {
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
    executeSql.mockImplementation(async (query) => {
      if (typeof query === 'string' && query.includes('count(*)::int AS count')) {
        return { rows: [{ count: 1 }] };
      }
      return { rows: [] };
    });

    vi.spyOn(boss, 'getQueueStats').mockResolvedValue(
      queueResult('any-queue', {
        queuedCount: 1,
        activeCount: 1,
        deferredCount: 1,
      })
    );

    await emitHeartbeatMetrics(boss, baseMetrics);

    // 4 queues * (1+1+1=3) + 1 = 13
    expect(logger.info).toHaveBeenCalledWith('Worker heartbeat', {
      scope: 'aggregate_all_queues',
      uptimeSeconds: expect.any(Number),
      activeJobs: 3,
      processed: 10,
      failed: 2,
      avgProcessingTimeSeconds: 2.5,
      queueSize: 13,
      memory: {
        rssMb: expect.any(Number),
        heapUsedMb: expect.any(Number),
      },
    });
  });

  it('asserts per-queue dimensions on worker_queue_size_per_queue for each of the 5 queues', async () => {
    const { boss, executeSql } = fakeBoss();
    executeSql.mockImplementation(async (query) => {
      if (typeof query === 'string' && query.includes('count(*)::int AS count')) {
        return { rows: [{ count: 9 }] };
      }
      return { rows: [] };
    });

    vi.spyOn(boss, 'getQueueStats').mockImplementation(async (queueName) => {
      if (queueName === QUEUE_NAMES.USFM_EXPORT)
        return queueResult(queueName, { queuedCount: 10, activeCount: 0, deferredCount: 0 });
      if (queueName === QUEUE_NAMES.AI_SUGGESTIONS)
        return queueResult(queueName, { queuedCount: 20, activeCount: 0, deferredCount: 0 });
      if (queueName === QUEUE_NAMES.DBL_INGEST_TEXT)
        return queueResult(queueName, { queuedCount: 30, activeCount: 0, deferredCount: 0 });
      if (queueName === QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY)
        return queueResult(queueName, { queuedCount: 40, activeCount: 0, deferredCount: 0 });
      return null as unknown as QueueResult;
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

  it('handles null queue stats gracefully without throwing and counts 0', async () => {
    const { boss, executeSql } = fakeBoss();
    executeSql.mockImplementation(async (query) => {
      if (typeof query === 'string' && query.includes('count(*)::int AS count')) {
        return { rows: [{ count: 0 }] };
      }
      return { rows: [] };
    });

    vi.spyOn(boss, 'getQueueStats').mockResolvedValue(null as unknown as QueueResult);

    await emitHeartbeatMetrics(boss, {
      ...baseMetrics,
      jobsProcessed: 0,
      totalProcessingTime: 0,
    });

    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size', 0);
    expect(logger.metric).toHaveBeenCalledWith('worker_avg_processing_seconds', 0);
    expect(logger.metric).toHaveBeenCalledWith('worker_queue_size_per_queue', 0, {
      queue: QUEUE_NAMES.USFM_EXPORT,
    });
  });

  it('on stats error, asserts no metrics emitted and error logged', async () => {
    const { boss } = fakeBoss();
    const statsError = new Error('getQueueStats failed');
    vi.spyOn(boss, 'getQueueStats').mockRejectedValue(statsError);

    await emitHeartbeatMetrics(boss, baseMetrics);

    expect(logger.metric).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('Error in heartbeat', { error: statsError });
  });

  it('on countPendingQueueJobs error, asserts no metrics emitted and error logged', async () => {
    const { boss, executeSql } = fakeBoss();
    vi.spyOn(boss, 'getQueueStats').mockResolvedValue(
      queueResult('any-queue', { queuedCount: 0, activeCount: 0, deferredCount: 0 })
    );
    const dbError = new Error('Database query execution error');
    executeSql.mockRejectedValue(dbError);

    await emitHeartbeatMetrics(boss, baseMetrics);

    expect(logger.metric).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('Error in heartbeat', { error: dbError });
  });
});
