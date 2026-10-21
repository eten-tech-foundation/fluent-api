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
import { fakeBoss, queueResult } from '@/test/utils/test-helpers';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('worker queue convention', () => {
  it('creates the DLQ first and converges routing on an existing source queue', async () => {
    const fake = fakeBoss();
    fake.getQueue.mockImplementation(async (name) =>
      name === 'ingestion' ? queueResult(name) : null
    );
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

  it('preserves a custom destination and raises only its short retention settings', async () => {
    const fake = fakeBoss();
    fake.getQueue.mockImplementation(async (name) =>
      name === 'ingestion'
        ? queueResult(name, { deadLetter: 'custom-failures', retryLimit: 3 })
        : queueResult(name, { retentionSeconds: 60, deleteAfterSeconds: DLQ_RETENTION_SECONDS * 2 })
    );

    await ensureWorkerQueue(fake.boss, 'ingestion', { retryLimit: 3 });

    expect(fake.getQueue.mock.calls).toEqual([['ingestion'], ['custom-failures']]);
    expect(fake.createQueue).not.toHaveBeenCalled();
    expect(fake.updateQueue.mock.calls).toEqual([
      [
        'custom-failures',
        {
          retentionSeconds: DLQ_RETENTION_SECONDS,
          deleteAfterSeconds: DLQ_RETENTION_SECONDS * 2,
        },
      ],
    ]);
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
    fake.createQueue.mockImplementation(async (_name, options) => {
      if (options) options.policy ??= 'standard';
    });
    fake.getQueue.mockImplementation(async (name) =>
      queueResult(name, { retentionSeconds: 6_000_000, deleteAfterSeconds: 7_000_000 })
    );
    await ensureWorkerQueue(fake.boss, 'ingestion', { policy: 'exclusive', retryLimit: 3 });
    expect(fake.updateQueue).not.toHaveBeenCalledWith('ingestion-dlq', expect.anything());
    expect(fake.updateQueue).toHaveBeenCalledWith('ingestion', {
      retryLimit: 3,
      deadLetter: 'ingestion-dlq',
    });
  });

  it('skips queue writes when mutable options already match', async () => {
    const fake = fakeBoss();
    fake.getQueue.mockImplementation(async (name) =>
      name === 'ingestion-dlq'
        ? queueResult(name, {
            retentionSeconds: DLQ_RETENTION_SECONDS,
            deleteAfterSeconds: DLQ_RETENTION_SECONDS,
          })
        : queueResult(name, { retryLimit: 3, deadLetter: 'ingestion-dlq' })
    );

    await ensureWorkerQueue(fake.boss, 'ingestion', { retryLimit: 3 });

    expect(fake.createQueue).not.toHaveBeenCalled();
    expect(fake.updateQueue).not.toHaveBeenCalled();
  });

  it('keeps legacy export queues even if only diagnostic history remains', async () => {
    const fake = fakeBoss();
    fake.getQueue.mockImplementation(async (name) =>
      name === 'usfm-export' ? queueResult(name, { policy: 'standard' }) : null
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
      name === 'ai-suggestions' ? queueResult(name, { policy: 'standard' }) : null
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
      name === 'ai-suggestions' ? queueResult(name, { policy: 'exclusive' }) : null
    );
    await ensureAiSuggestionQueue(fake.boss);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('dead-letter monitoring', () => {
  it('reports another queue while the first query is still pending', async () => {
    const fake = fakeBoss();
    fake.getQueues.mockResolvedValue([queueResult('slow-dlq'), queueResult('fast-dlq')]);
    let finish!: () => void;
    fake.executeSql.mockImplementation(async (query: string, parameters?: unknown[]) => {
      if (query.includes('pgboss.version')) return { rows: [{ version: 26 }] };
      if (parameters?.[0] === 'slow-dlq') {
        return new Promise((resolve) => {
          finish = () => resolve({ rows: [{ depth: 0 }] });
        });
      }
      return { rows: [{ depth: 0 }] };
    });
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
      queueResult('export', { deadLetter: 'failures' }),
      queueResult('ai', { deadLetter: 'failures' }),
      queueResult('old-dlq'),
      queueResult('failures'),
    ]);
    fake.executeSql.mockImplementation(async (query: string) => {
      if (query.includes('pgboss.version')) return { rows: [{ version: 26 }] };
      return {
        rows: [
          { depth: 3, queuedCount: 2, activeCount: 1, deferredCount: 2, oldestCreatedOn: null },
        ],
      };
    });
    await reportDeadLetterQueues(fake.boss);
    expect(fake.executeSql.mock.calls.slice(1).map((call) => call[1])).toEqual([
      ['failures'],
      ['old-dlq'],
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worker_dlq_depth', queueName: 'failures', depth: 3 }),
      expect.any(String)
    );
    expect(fake.updateQueue).not.toHaveBeenCalled();
    expect(fake.deleteQueue).not.toHaveBeenCalled();
  });

  it('reports zero after the backlog clears, with flat structured dimensions', async () => {
    const fake = fakeBoss();
    fake.getQueues.mockResolvedValue([queueResult('old-dlq')]);
    await reportDeadLetterQueues(fake.boss);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'worker_dlq_depth', queueName: 'old-dlq', depth: 0 }),
      'Worker dead-letter queue is empty'
    );
  });

  it('continues after a queue read failure and reports discovery failures', async () => {
    const fake = fakeBoss();
    fake.getQueues.mockResolvedValue([queueResult('one-dlq'), queueResult('two-dlq')]);
    fake.executeSql.mockImplementation(async (query: string, parameters?: unknown[]) => {
      if (query.includes('pgboss.version')) return { rows: [{ version: 26 }] };
      if (parameters?.[0] === 'one-dlq') throw new Error('database read failed');
      return {
        rows: [
          { depth: 0, queuedCount: 0, activeCount: 0, deferredCount: 0, oldestCreatedOn: null },
        ],
      };
    });
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

  it('reports an explicit error and skips job queries for an unsupported schema', async () => {
    const fake = fakeBoss();
    fake.executeSql.mockResolvedValue({ rows: [{ version: 25 }] });

    await reportDeadLetterQueues(fake.boss);

    expect(fake.getQueues).not.toHaveBeenCalled();
    expect(fake.executeSql).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      {
        event: 'worker_dlq_monitor_schema_mismatch',
        expectedSchemaVersion: 26,
        actualSchemaVersion: 25,
      },
      'Worker dead-letter queue monitoring requires pg-boss schema version 26'
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
    await Promise.resolve();
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
    fake.getQueues.mockResolvedValue([queueResult('stuck-dlq')]);
    fake.executeSql.mockImplementation((query: string) =>
      query.includes('pgboss.version')
        ? Promise.resolve({ rows: [{ version: 26 }] })
        : new Promise(() => {})
    );
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
