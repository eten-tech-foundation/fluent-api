import type { PgBoss } from 'pg-boss';

import { getUsfmImportsReadyForMaterialization } from '@/domains/projects/usfm-import.service';
import { logger } from '@/lib/logger';
import { QUEUE_NAMES } from '@/lib/queue';

export const USFM_IMPORT_RECOVERY_INTERVAL_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** Rediscover durable pending imports after enqueue failures, including while this worker lives. */
export function startUsfmImportRecovery(boss: Pick<PgBoss, 'send'>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let stopped = false;

  const recover = async () => {
    try {
      const imports = await getUsfmImportsReadyForMaterialization();
      for (const { bibleId, bookId } of imports) {
        if (stopped) return;
        try {
          // Exclusive queue policy deduplicates this with immediate/ingestion retries.
          // Keep every pending row intact until the materializer succeeds.
          await boss.send(
            QUEUE_NAMES.USFM_IMPORT_MATERIALIZE,
            { bibleId, bookId },
            { singletonKey: `${bibleId}:${bookId}` }
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
