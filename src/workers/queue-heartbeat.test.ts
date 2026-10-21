import type { PgBoss } from 'pg-boss';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { countPendingQueueJobs } from './queue-heartbeat';

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
