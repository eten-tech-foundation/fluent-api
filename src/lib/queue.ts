import { PgBoss } from 'pg-boss';

import { logger } from '@/lib/logger';

let boss: PgBoss | null = null;

export const QUEUE_NAMES = {
  USFM_EXPORT: 'usfm-export',
  /** Dead-letter destination for exports that exhaust their retries. */
  USFM_EXPORT_DLQ: 'usfm-export-dlq',
} as const;

export interface USFMExportJob {
  projectUnitId: number;
  bookIds?: number[];
  /** User id of the authenticated requester; jobs and downloads are bound to it. */
  requestedBy?: number;
}

export async function initializeQueue(): Promise<PgBoss> {
  if (boss) {
    return boss;
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is required for queue initialization');
  }

  boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    // Bootstrap creates the pgboss schema; skip the CREATE SCHEMA DDL so
    // api_user (runtime role) doesn't need CREATE privilege on the database.
    createSchema: false,
    max: 10,
    application_name: 'fluent-server-queue',
    superviseIntervalSeconds: 60,
    maintenanceIntervalSeconds: 86400,
    monitorIntervalSeconds: 60,
  });

  boss.on('error', (error: Error) => {
    logger.error('PgBoss error occurred', {
      error: error.message,
      stack: error.stack,
      name: error.name,
      code: (error as any).code,
      cause: error.cause,
    });
  });

  await boss.start();
  logger.info('PgBoss queue initialized');

  return boss;
}

const EXPORT_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 600,
  deadLetter: QUEUE_NAMES.USFM_EXPORT_DLQ,
} as const;

/**
 * Creates/converges the export queues. The 'exclusive' policy backs singletonKey
 * dedupe (at most one job per key in created/retry/active). createQueue is a
 * no-op for existing queues and policy is immutable, so a queue created with an
 * older policy is dropped and recreated (pre-enablement: nothing user-facing
 * queues jobs yet); the remaining options are converged via updateQueue.
 */
export async function ensureExportQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUE_NAMES.USFM_EXPORT_DLQ);

  const existing = await boss.getQueue(QUEUE_NAMES.USFM_EXPORT);
  if (existing && existing.policy !== 'exclusive') {
    logger.warn('Recreating usfm-export queue with exclusive policy', {
      previousPolicy: existing.policy,
    });
    await boss.deleteQueue(QUEUE_NAMES.USFM_EXPORT);
  }

  await boss.createQueue(QUEUE_NAMES.USFM_EXPORT, {
    policy: 'exclusive',
    ...EXPORT_QUEUE_OPTIONS,
  });
  await boss.updateQueue(QUEUE_NAMES.USFM_EXPORT, EXPORT_QUEUE_OPTIONS);
}

export async function getQueue(): Promise<PgBoss> {
  if (!boss) {
    throw new Error('Queue not initialized. Call initializeQueue() first.');
  }
  return boss;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30000 });
    boss = null;
    logger.info('PgBoss queue stopped');
  }
}
