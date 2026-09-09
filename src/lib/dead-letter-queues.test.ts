import type { PgBoss } from 'pg-boss';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DLQ_RETENTION_SECONDS,
  DLQ_SHUTDOWN_TIMEOUT_MS,
  ensureWorkerQueue,
  reportDeadLetterQueues,
  startDeadLetterMonitor,
} from '@/lib/dead-letter-queues';
import { logger } from '@/lib/logger';
import { ensureAiSuggestionQueue, ensureExportQueues } from '@/lib/queue';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function fakeBoss() {
  const executeSql = vi.fn().mockResolvedValue({
    rows: [{ depth: 0, queuedCount: 0, activeCount: 0, deferredCount: 0, oldestCreatedOn: null }],
  });
  const methods = {
    getQueue: vi.fn().mockResolvedValue(null),
    createQueue: vi.fn(),
    updateQueue: vi.fn(),
    deleteQueue: vi.fn(),
    getQueues: vi.fn().mockResolvedValue([]),
    getDb: () => ({ executeSql }),
  };
  return { boss: methods as unknown as PgBoss, ...methods, executeSql };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('worker queue convention', () => {
  it('creates the DLQ first and converges routing on an existing source queue', async () => {
    const fake = fakeBoss();
    fake.getQueue.mockImplementation(async (name) => (name === 'ingestion' ? { name } : null));
    await ensureWorkerQueue(fake.boss, 'ingestion');
    expect(fake.createQueue.mock.calls).toEqual([
      [
        'ingestion-dlq',
        { retentionSeconds: DLQ_RETENTION_SECONDS, deleteAfterSeconds: DLQ_RETENTION_SECONDS },
      ],
    ]);
    expect(fake.updateQueue).toHaveBeenCalledWith('ingestion', { deadLetter: 'ingestion-dlq' });
    expect(fake.deleteQueue).not.toHaveBeenCalled();
  });

  it('creates new queues with their final settings without redundant updates', async () => {
    const fake = fakeBoss();
    await ensureWorkerQueue(fake.boss, 'ingestion', { retryLimit: 3 });
    expect(fake.createQueue).toHaveBeenCalledWith('ingestion', {
      retryLimit: 3,
      deadLetter: 'ingestion-dlq',
    });
    expect(fake.updateQueue).not.toHaveBeenCalled();
  });

  it('preserves longer retention and never updates immutable source policy', async () => {
    const fake = fakeBoss();
    fake.createQueue.mockImplementation((_name, options) => {
      options.policy ??= 'standard';
    });
    fake.getQueue.mockResolvedValue({ retentionSeconds: 6_000_000, deleteAfterSeconds: 7_000_000 });
    await ensureWorkerQueue(fake.boss, 'ingestion', { policy: 'exclusive', retryLimit: 3 });
    expect(fake.updateQueue).toHaveBeenCalledWith('ingestion-dlq', {
      retentionSeconds: 6_000_000,
      deleteAfterSeconds: 7_000_000,
    });
    expect(fake.updateQueue).toHaveBeenCalledWith('ingestion', {
      retryLimit: 3,
      deadLetter: 'ingestion-dlq',
    });
  });

  it('keeps legacy export queues even if only diagnostic history remains', async () => {
    const fake = fakeBoss();
    fake.getQueue.mockImplementation(async (name) =>
      name === 'usfm-export' ? { policy: 'standard' } : null
    );
    await ensureExportQueues(fake.boss);
    expect(fake.deleteQueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worker_queue_policy_mismatch' }),
      expect.any(String)
    );
    expect(fake.updateQueue).toHaveBeenCalledWith('usfm-export', {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 600,
      deadLetter: 'usfm-export-dlq',
    });
  });

  it('adds a DLQ to the current AI queue and keeps its retry contract', async () => {
    const fake = fakeBoss();
    fake.getQueue.mockImplementation(async (name) =>
      name === 'ai-suggestions' ? { policy: 'standard' } : null
    );
    await ensureAiSuggestionQueue(fake.boss);
    expect(fake.updateQueue).toHaveBeenCalledWith('ai-suggestions', {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 3600,
      deadLetter: 'ai-suggestions-dlq',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'worker_queue_policy_mismatch',
        queueName: 'ai-suggestions',
        previousPolicy: 'standard',
        expectedPolicy: 'exclusive',
      }),
      expect.any(String)
    );
  });

  it('does not warn for an existing exclusive queue', async () => {
    const fake = fakeBoss();
    fake.getQueue.mockImplementation(async (name) =>
      name === 'ai-suggestions' ? { policy: 'exclusive' } : null
    );
    await ensureAiSuggestionQueue(fake.boss);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('dead-letter monitoring', () => {
  it('reports another queue while the first query is still pending', async () => {
    const fake = fakeBoss();
    fake.getQueues.mockResolvedValue([{ name: 'slow-dlq' }, { name: 'fast-dlq' }]);
    let finish!: () => void;
    fake.executeSql.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve({ rows: [{ depth: 0 }] });
      })
    );
    const report = reportDeadLetterQueues(fake.boss);
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ queueName: 'fast-dlq', depth: 0 }),
        expect.any(String)
      )
    );
    finish();
    await report;
  });

  it('discovers custom, shared and orphaned DLQs without counting source retries', async () => {
    const fake = fakeBoss();
    fake.getQueues.mockResolvedValue([
      { name: 'export', deadLetter: 'failures' },
      { name: 'ai', deadLetter: 'failures' },
      { name: 'old-dlq' },
      { name: 'failures' },
    ]);
    fake.executeSql.mockResolvedValue({
      rows: [{ depth: 3, queuedCount: 2, activeCount: 1, deferredCount: 2, oldestCreatedOn: null }],
    });
    await reportDeadLetterQueues(fake.boss);
    expect(fake.executeSql.mock.calls.map((call) => call[1])).toEqual([['failures'], ['old-dlq']]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worker_dlq_depth', queueName: 'failures', depth: 3 }),
      expect.any(String)
    );
    expect(fake.updateQueue).not.toHaveBeenCalled();
    expect(fake.deleteQueue).not.toHaveBeenCalled();
  });

  it('reports zero after the backlog clears, with flat structured dimensions', async () => {
    const fake = fakeBoss();
    fake.getQueues.mockResolvedValue([{ name: 'old-dlq' }]);
    await reportDeadLetterQueues(fake.boss);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worker_dlq_depth', queueName: 'old-dlq', depth: 0 }),
      'Worker dead-letter queue is empty'
    );
  });

  it('continues after a queue read failure and reports discovery failures', async () => {
    const fake = fakeBoss();
    fake.getQueues.mockResolvedValue([{ name: 'one-dlq' }, { name: 'two-dlq' }]);
    fake.executeSql.mockRejectedValueOnce(new Error('database read failed'));
    await reportDeadLetterQueues(fake.boss);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worker_dlq_monitor_error', queueName: 'one-dlq' }),
      expect.any(String)
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ queueName: 'two-dlq' }),
      expect.any(String)
    );
    fake.getQueues.mockRejectedValue(new Error('discovery unavailable'));
    await expect(reportDeadLetterQueues(fake.boss)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'worker_dlq_monitor_error',
        error: 'discovery unavailable',
      }),
      expect.any(String)
    );
  });

  it('sweeps immediately, avoids overlap, waits for shutdown and stops its timer', async () => {
    vi.useFakeTimers();
    const fake = fakeBoss();
    let finish!: (value: []) => void;
    fake.getQueues.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const stop = startDeadLetterMonitor(fake.boss);
    expect(fake.getQueues).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.getQueues).toHaveBeenCalledTimes(1);
    let stopped = false;
    const shutdown = stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish([]);
    await shutdown;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.getQueues).toHaveBeenCalledTimes(1);
  });

  it('resumes on the next interval after a failed sweep', async () => {
    vi.useFakeTimers();
    const fake = fakeBoss();
    fake.getQueues.mockRejectedValueOnce(new Error('temporary outage'));
    const stop = startDeadLetterMonitor(fake.boss);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.getQueues).toHaveBeenCalledTimes(2);
    await stop();
  });

  it('bounds shutdown when a query never returns and never starts another sweep', async () => {
    vi.useFakeTimers();
    const fake = fakeBoss();
    fake.getQueues.mockResolvedValue([{ name: 'stuck-dlq' }]);
    fake.executeSql.mockReturnValue(new Promise(() => {}));
    const stop = startDeadLetterMonitor(fake.boss);
    await vi.advanceTimersByTimeAsync(0);
    const shutdown = stop();
    await vi.advanceTimersByTimeAsync(DLQ_SHUTDOWN_TIMEOUT_MS);
    await shutdown;
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worker_dlq_monitor_shutdown_timeout' }),
      expect.any(String)
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.getQueues).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
