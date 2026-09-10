import { Readable } from 'node:stream';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createUSFMZipStreamAsync, getProjectName } from '@/domains/usfm/usfm.service';
import { uploadExportStream } from '@/lib/blob-storage';
import {
  DLQ_RETENTION_SECONDS,
  ensureWorkerQueue,
  reportDeadLetterQueues,
} from '@/lib/dead-letter-queues';
import { migrateExclusiveWorkerQueue } from '@/lib/exclusive-worker-queue-migration';
import { logger } from '@/lib/logger';
import { ensureAiSuggestionQueue, ensureExportQueues, QUEUE_NAMES } from '@/lib/queue';
import { triggerAiSuggestions } from '@/lib/services/fluent-ai/fluent-ai.client';
import { registerAiTriggerWorker } from '@/workers/ai-trigger.worker';
import { registerUSFMExportWorker } from '@/workers/usfm-export.worker';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/domains/usfm/usfm.service', () => ({
  createUSFMZipStreamAsync: vi.fn(),
  getProjectName: vi.fn(),
}));
vi.mock('@/lib/blob-storage', () => ({ uploadExportStream: vi.fn() }));
vi.mock('@/lib/services/fluent-ai/fluent-ai.client', () => ({ triggerAiSuggestions: vi.fn() }));

const connectionString = process.env.DLQ_TEST_DATABASE_URL;

// This suite writes jobs and expires synthetic fixtures. Never use the app's
// DATABASE_URL or a shared database. See docs/runbooks/worker-dead-letter-queues.md.
describe.skipIf(!connectionString)('dead-letter queues with PostgreSQL and pg-boss 12', () => {
  let boss: PgBoss;
  let migrationSql: postgres.Sql;
  const errors: Error[] = [];
  const exportQueue = QUEUE_NAMES.USFM_EXPORT;
  const exportDlq = QUEUE_NAMES.USFM_EXPORT_DLQ;

  async function rows(name: string) {
    return (
      await boss
        .getDb()
        .executeSql('SELECT * FROM pgboss.job WHERE name = $1 ORDER BY created_on, id', [name])
    ).rows;
  }

  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/fluent_dlq_test'
    ) {
      throw new Error('DLQ tests require a disposable local database named fluent_dlq_test');
    }
    boss = new PgBoss({
      connectionString,
      schema: 'pgboss',
      supervise: false,
      schedule: false,
      max: 2,
    });
    boss.on('error', (error) => errors.push(error));
    await boss.start();
    if ((await boss.getQueues()).some((queue) => !queue.name.startsWith('__'))) {
      throw new Error('DLQ tests require an empty disposable database');
    }
    migrationSql = postgres(connectionString!, { max: 1 });
  });

  afterAll(async () => {
    await migrationSql?.end();
    await boss?.stop({ graceful: true });
    expect(errors).toEqual([]);
  });

  it('keeps legacy source history and existing DLQ rows unchanged during setup', async () => {
    await boss.createQueue(exportDlq);
    await boss.createQueue(exportQueue, { policy: 'standard', retryLimit: 0 });
    const oldSourceId = await boss.send(exportQueue, { projectUnitId: 10 });
    await boss.fetch(exportQueue);
    await boss.fail(exportQueue, oldSourceId!, new Error('legacy failure'));
    await boss.send(exportDlq, { originalPayload: 'keep this evidence' });
    const sourceBefore = await rows(exportQueue);
    const dlqBefore = await rows(exportDlq);
    await ensureExportQueues(boss);
    await ensureExportQueues(boss);
    expect(await rows(exportQueue)).toEqual(sourceBefore);
    expect(await rows(exportDlq)).toEqual(dlqBefore);
    expect(await boss.getQueue(exportQueue)).toMatchObject({
      policy: 'standard',
      deadLetter: exportDlq,
    });
    expect(await boss.getQueue(exportDlq)).toMatchObject({
      retentionSeconds: DLQ_RETENTION_SECONDS,
    });
  });

  it('migrates a legacy queue without losing history and enforces singleton dedupe', async () => {
    const deferredId = await boss.send(
      exportQueue,
      { fixture: 'pending migration' },
      {
        startAfter: new Date(Date.now() + 60_000),
      }
    );
    const before = await rows(exportQueue);
    const dlqBefore = await rows(exportDlq);
    await expect(migrateExclusiveWorkerQueue(migrationSql, exportQueue)).resolves.toMatchObject({
      changed: false,
      previousPolicy: 'standard',
      pendingJobs: 1,
    });
    expect(await rows(exportQueue)).toEqual(before);
    await expect(migrateExclusiveWorkerQueue(migrationSql, exportQueue, true)).rejects.toThrow(
      'still has 1'
    );
    expect((await boss.getQueue(exportQueue))?.policy).toBe('standard');
    expect(await rows(exportQueue)).toEqual(before);

    await boss.cancel(exportQueue, deferredId!);
    const drained = await rows(exportQueue);
    await expect(
      migrateExclusiveWorkerQueue(migrationSql, exportQueue, true)
    ).resolves.toMatchObject({ changed: true });
    expect(await rows(exportQueue)).toEqual(
      drained.map((row) => ({ ...row, policy: 'exclusive' }))
    );
    expect(await rows(exportDlq)).toEqual(dlqBefore);
    expect((await boss.getQueue(exportQueue))?.policy).toBe('exclusive');
    await expect(
      migrateExclusiveWorkerQueue(migrationSql, exportQueue, true)
    ).resolves.toMatchObject({ changed: false });

    const key = { singletonKey: 'migration-dedupe-proof' };
    const first = await boss.send(exportQueue, { fixture: 'first' }, key);
    expect(first).toBeTruthy();
    expect(await boss.send(exportQueue, { fixture: 'duplicate' }, key)).toBeNull();
    await boss.cancel(exportQueue, first!);
  });

  it('adds the exclusive index when migrating a dedicated AI queue partition', async () => {
    await boss.createQueue(QUEUE_NAMES.AI_SUGGESTIONS, { policy: 'standard', partition: true });
    await expect(
      migrateExclusiveWorkerQueue(migrationSql, QUEUE_NAMES.AI_SUGGESTIONS, true)
    ).resolves.toMatchObject({ changed: true });
    const options = { singletonKey: 'partition-dedupe-proof' };
    const id = await boss.send(QUEUE_NAMES.AI_SUGGESTIONS, { fixture: 'partition' }, options);
    expect(id).toBeTruthy();
    expect(await boss.send(QUEUE_NAMES.AI_SUGGESTIONS, {}, options)).toBeNull();
    await boss.cancel(QUEUE_NAMES.AI_SUGGESTIONS, id!);
  });

  it('reports a retry separately from a real terminal DLQ arrival and preserves payload/output', async () => {
    await ensureWorkerQueue(boss, 'retry-probe', { retryLimit: 1, retryDelay: 0 });
    const payload = { projectUnitId: 20, requestedBy: 7 };
    const id = await boss.send('retry-probe', payload);
    await boss.fetch('retry-probe');
    await boss.fail('retry-probe', id!, new Error('first attempt'));
    expect((await boss.getJobById('retry-probe', id!))?.state).toBe('retry');
    await reportDeadLetterQueues(boss);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ queueName: 'retry-probe-dlq', depth: 0 }),
      expect.any(String)
    );
    await boss.fetch('retry-probe');
    await boss.fail('retry-probe', id!, new Error('terminal attempt'));
    const before = await rows('retry-probe-dlq');
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      state: 'created',
      data: payload,
      output: { message: 'terminal attempt' },
    });
    expect(before[0].id).not.toBe(id);
    expect((before[0].keep_until.getTime() - before[0].created_on.getTime()) / 1000).toBeCloseTo(
      DLQ_RETENTION_SECONDS,
      0
    );
    await reportDeadLetterQueues(boss);
    await reportDeadLetterQueues(boss);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'worker_dlq_depth',
        queueName: 'retry-probe-dlq',
        depth: 1,
      }),
      expect.any(String)
    );
    expect(await rows('retry-probe-dlq')).toEqual(before);
  });

  it('runs the real export worker through an upload failure and exhausted retries', async () => {
    await boss.updateQueue(exportQueue, { retryLimit: 1, retryDelay: 0, retryBackoff: false });
    vi.mocked(createUSFMZipStreamAsync).mockImplementation(
      async () => ({ ok: true, data: { stream: Readable.from(['zip']), cleanup: vi.fn() } }) as any
    );
    vi.mocked(uploadExportStream).mockRejectedValue(new Error('simulated R2 outage'));
    await registerUSFMExportWorker(boss);
    const payload = { projectUnitId: 30, requestedBy: 7 };
    const id = await boss.send(exportQueue, payload);
    await vi.waitFor(
      async () => {
        expect((await boss.getJobById(exportQueue, id!))?.state).toBe('failed');
      },
      { timeout: 15_000, interval: 100 }
    );
    expect(uploadExportStream).toHaveBeenCalledTimes(2);
    expect(await rows(exportDlq)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: payload,
          state: 'created',
          output: expect.objectContaining({
            message: expect.stringContaining('simulated R2 outage'),
          }),
        }),
      ])
    );
  }, 20_000);

  it('lets a transient export failure recover without adding a DLQ entry', async () => {
    const dlqBefore = await rows(exportDlq);
    vi.mocked(uploadExportStream)
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValue({
        filename: 'export.zip',
        sizeBytes: 3,
        expiresAt: new Date(Date.now() + 60_000),
      });
    vi.mocked(getProjectName).mockResolvedValue({ ok: true, data: 'Test' });
    const id = await boss.send(exportQueue, { projectUnitId: 31, requestedBy: 7 });
    await vi.waitFor(
      async () => {
        expect((await boss.getJobById(exportQueue, id!))?.state).toBe('completed');
      },
      { timeout: 15_000, interval: 100 }
    );
    expect(await rows(exportDlq)).toEqual(dlqBefore);
  }, 20_000);

  it('routes each failed AI batch member to its DLQ through the real worker', async () => {
    await ensureAiSuggestionQueue(boss);
    await boss.updateQueue(QUEUE_NAMES.AI_SUGGESTIONS, {
      retryLimit: 1,
      retryDelay: 0,
      retryBackoff: false,
    });
    vi.mocked(triggerAiSuggestions).mockRejectedValue(new Error('simulated AI outage'));
    await registerAiTriggerWorker(boss, {});
    const ids: Array<string | null> = [];
    for (const projectUnitId of [40, 41]) {
      ids.push(
        await boss.send(
          QUEUE_NAMES.AI_SUGGESTIONS,
          {
            projectUnitId,
            bibleId: 1,
            bookCode: 'GEN',
            chapterNumber: 1,
            verseStart: 1,
            verseEnd: 2,
          },
          { singletonKey: `project-unit-${projectUnitId}` }
        )
      );
    }
    expect(ids.every(Boolean)).toBe(true);
    await vi.waitFor(
      async () => {
        for (const id of ids)
          expect((await boss.getJobById(QUEUE_NAMES.AI_SUGGESTIONS, id!))?.state).toBe('failed');
      },
      { timeout: 15_000, interval: 100 }
    );
    expect(await rows('ai-suggestions-dlq')).toHaveLength(2);
    await reportDeadLetterQueues(boss);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueName: 'ai-suggestions-dlq', depth: 2 }),
      expect.any(String)
    );
  }, 20_000);

  it('observes worker timeouts and pg-boss retention, including an accurate return to zero', async () => {
    await ensureWorkerQueue(boss, 'expiry-probe', { retryLimit: 0, expireInSeconds: 1 });
    const id = await boss.send('expiry-probe', { fixture: 'expired worker' });
    await boss.fetch('expiry-probe');
    // Only this synthetic fixture is aged. No production or pre-existing data.
    await boss
      .getDb()
      .executeSql(
        "UPDATE pgboss.job SET started_on = now() - interval '2 seconds' WHERE name = $1 AND id = $2",
        ['expiry-probe', id]
      );
    await boss.supervise('expiry-probe');
    expect((await boss.getJobById('expiry-probe', id!))?.state).toBe('failed');
    expect(await rows('expiry-probe-dlq')).toHaveLength(1);
    await reportDeadLetterQueues(boss);
    const retained = await rows('expiry-probe-dlq');
    await boss.supervise('expiry-probe-dlq');
    expect(await rows('expiry-probe-dlq')).toEqual(retained);
    await boss
      .getDb()
      .executeSql(
        "UPDATE pgboss.job SET keep_until = now() - interval '1 second' WHERE name = $1",
        ['expiry-probe-dlq']
      );
    await boss
      .getDb()
      .executeSql('UPDATE pgboss.queue SET maintain_on = NULL WHERE name = $1', [
        'expiry-probe-dlq',
      ]);
    await boss.supervise('expiry-probe-dlq');
    expect(await rows('expiry-probe-dlq')).toHaveLength(0);
    await reportDeadLetterQueues(boss);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ queueName: 'expiry-probe-dlq', depth: 0 }),
      expect.any(String)
    );
  });
});
