import { PgBoss } from 'pg-boss';

import { ensureWorkerQueue } from '@/lib/dead-letter-queues';
import { logger } from '@/lib/logger';

let boss: PgBoss | null = null;

export const QUEUE_NAMES = {
  USFM_EXPORT: 'usfm-export',
  /** Dead-letter destination for exports that exhaust their retries. */
  USFM_EXPORT_DLQ: 'usfm-export-dlq',
  AI_SUGGESTIONS: 'ai-suggestions',
  DBL_INGEST_TEXT: 'dbl-ingest-text',
  DBL_INGEST_TEXT_PRIORITY: 'dbl-ingest-text-priority',
} as const;

export interface DblIngestTextJob {
  projectId: number;
  bibleId: number;
  bookCodes: string[];
}

export interface USFMExportJob {
  projectUnitId: number;
  bookIds?: number[];
  /** User id of the authenticated requester; jobs and downloads are bound to it. */
  requestedBy?: number;
}

export interface AiSuggestionTriggerJob {
  projectUnitId: number;
  bibleId: number;
  bookCode: string;
  chapterNumber: number;
  verseStart: number;
  verseEnd: number;
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
    // provision-db.ts (dev/qa) and bootstrap.ts (local) create the pgboss
    // schema as a superuser before the API starts, so the runtime role
    // (web_user in dev/qa, api_user locally) never needs CREATE ON DATABASE.
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
} as const;

/**
 * Creates/converges the export queues. The 'exclusive' policy backs singletonKey
 * dedupe (at most one job per key in queued/active/deferred). Policy is immutable;
 * preserve older queues and their diagnostic history, and warn for an explicit
 * migration instead of deleting a queue during API/worker startup.
 */
export async function ensureExportQueues(boss: PgBoss): Promise<void> {
  const existing = await boss.getQueue(QUEUE_NAMES.USFM_EXPORT);
  if (existing && existing.policy !== 'exclusive') {
    logger.warn(
      {
        event: 'worker_queue_policy_mismatch',
        queueName: QUEUE_NAMES.USFM_EXPORT,
        previousPolicy: existing.policy,
        expectedPolicy: 'exclusive',
      },
      'Worker queue policy differs; preserving jobs until an explicit migration'
    );
  }

  await ensureWorkerQueue(boss, QUEUE_NAMES.USFM_EXPORT, {
    policy: 'exclusive',
    ...EXPORT_QUEUE_OPTIONS,
  });
}

export async function ensureAiSuggestionQueue(boss: PgBoss): Promise<void> {
  await ensureWorkerQueue(boss, QUEUE_NAMES.AI_SUGGESTIONS, {
    policy: 'exclusive',
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 3600,
  });
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
