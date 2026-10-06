import type { PgBoss } from 'pg-boss';

import { getUsfmImportsReadyForMaterialization } from '@/domains/projects/usfm-import.service';
import { logger } from '@/lib/logger';
import { PG_BOSS_SCHEMA_VERSION } from '@/lib/pg-boss-schema';
import { QUEUE_NAMES } from '@/lib/queue';

export const USFM_IMPORT_RECOVERY_INTERVAL_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** Rediscover durable pending imports after enqueue failures, including while this worker lives. */
export function startUsfmImportRecovery(
  boss: Pick<PgBoss, 'send' | 'getQueue' | 'getDb' | 'schemaVersion'>
): () => Promise<void> {
  let running: Promise<void> | undefined;
  let stopped = false;

  const recover = async () => {
    try {
      const imports = await getUsfmImportsReadyForMaterialization();
      if (stopped || imports.length === 0) return;
      if ((await boss.schemaVersion()) !== PG_BOSS_SCHEMA_VERSION) {
        throw new Error('Unsupported pg-boss schema for USFM import recovery');
      }
      const queue = await boss.getQueue(QUEUE_NAMES.USFM_IMPORT_MATERIALIZE);
      if (!queue?.deadLetter) {
        throw new Error('USFM import recovery requires a dead-letter queue');
      }
      // Retained failures require operator investigation instead of another retry cycle.
      // Include queued/running jobs: pg-boss atomically moves an exhausted job to
      // the DLQ, so a job failing after this snapshot remains excluded for this sweep.
      const { rows } = await boss.getDb().executeSql(
        `SELECT DISTINCT (data->>'bibleId') || ':' || (data->>'bookId') AS key
           FROM pgboss.job
          WHERE name = $1 OR (name = $2 AND state < 'completed')`,
        [queue.deadLetter, QUEUE_NAMES.USFM_IMPORT_MATERIALIZE]
      );
      const blockedKeys = new Set(rows.map((row: { key: string }) => row.key));
      for (const { bibleId, bookId } of imports) {
        if (stopped) return;
        const singletonKey = `${bibleId}:${bookId}`;
        if (blockedKeys.has(singletonKey)) continue;
        try {
          // Exclusive queue policy deduplicates this with immediate/ingestion retries.
          // Keep every pending row intact until the materializer succeeds.
          await boss.send(
            QUEUE_NAMES.USFM_IMPORT_MATERIALIZE,
            { bibleId, bookId },
            { singletonKey }
          );
        } catch (error) {
          logger.error('Failed to recover pending USFM import', { bibleId, bookId, error });
        }
      }
    } catch (error) {
      logger.error('Failed to discover pending USFM imports', { error });
    }
  };
  const sweep = () => {
    if (stopped || running) return;
    running = recover().finally(() => {
      running = undefined;
    });
  };

  sweep();
  const interval = setInterval(sweep, USFM_IMPORT_RECOVERY_INTERVAL_MS);
  interval.unref();

  return async () => {
    stopped = true;
    clearInterval(interval);
    if (!running) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            logger.warn('USFM import recovery shutdown timed out');
            resolve();
          }, SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
}
