import type { PgBoss } from 'pg-boss';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { reportDeadLetterQueues } from '@/lib/dead-letter-queues';

const client = vi.hoisted(() => ({ trackTrace: vi.fn() }));
vi.mock('@/env', () => ({
  default: { NODE_ENV: 'production', APPLICATIONINSIGHTS_CONNECTION_STRING: 'test-only' },
}));
vi.mock('applicationinsights', () => ({
  default: { setup: () => ({ start: vi.fn() }), defaultClient: client },
}));

afterEach(() => vi.restoreAllMocks());

describe('dLQ Application Insights telemetry', () => {
  it('sends queryable dimensions through the real production logger without job payloads', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boss = {
      getQueues: async () => [{ name: 'usfm-export-dlq' }],
      getDb: () => ({
        executeSql: async () => ({
          rows: [
            { depth: 1, queuedCount: 1, activeCount: 0, deferredCount: 0, oldestCreatedOn: null },
          ],
        }),
      }),
    } as unknown as PgBoss;

    await reportDeadLetterQueues(boss);

    expect(client.trackTrace).toHaveBeenCalledWith({
      message: 'Worker dead-letter queue contains jobs',
      severity: 2,
      properties: {
        event: 'worker_dlq_depth',
        queueName: 'usfm-export-dlq',
        depth: 1,
        queuedCount: 1,
        activeCount: 0,
        deferredCount: 0,
        oldestCreatedOn: null,
      },
    });
  });
});
