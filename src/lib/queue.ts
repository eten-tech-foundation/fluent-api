import { PgBoss } from 'pg-boss';

import { ensureWorkerQueue } from '@/lib/dead-letter-queues';
import { logger } from '@/lib/logger';

let boss: PgBoss | null = null;
let initPromise: Promise<PgBoss> | null = null;
// Distinct from `boss !== null`: readiness is published only after the
// instance has started AND its queues have converged — a started-but-
// unconverged boss would accept sends that then fail on missing queues.
let queueReady = false;

/** Retry delay between queue init attempts when the database is unreachable. */
const QUEUE_INIT_RETRY_DELAY_MS = 5_000;

// Dead-letter destinations are not listed here: deadLetterQueueName() derives
// them from the source name, so there is a single spelling of each.
export const QUEUE_NAMES = {
  USFM_EXPORT: 'usfm-export',
  AI_SUGGESTIONS: 'ai-suggestions',
  DBL_INGEST_TEXT: 'dbl-ingest-text',
  DBL_INGEST_TEXT_PRIORITY: 'dbl-ingest-text-priority',
  USFM_IMPORT_MATERIALIZE: 'usfm-import-materialize',
} as const;

export type DblIngestTextJob = {
  bibleId: number;
  bookCodes: string[];
} & ({ projectId: number; projectUnitId?: number } | { projectUnitId: number; projectId?: number });

export interface UsfmImportMaterializeJob {
  bibleId: number;
  bookId: number;
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
  /** Presence selects a heading-only job; scripture jobs omit these fields. */
  pericopeNumber?: string;
  pericopeSetId?: number;
}

/**
 * Connects pg-boss and starts it. The returned instance's queues are NOT yet
 * converged — that is the caller's job (API: initializeQueueWithRetry, which
 * gates readiness on it; worker: its explicit ensure calls). Concurrent calls
 * share one attempt, and a failed start leaves `boss` null so the next call
 * retries cleanly.
 */
export async function initializeQueue(): Promise<PgBoss> {
  if (boss) {
    return boss;
  }

  // A failed start() must not leave a half-open instance for the next attempt
  // or for getQueue() callers, so `boss` is only assigned after start succeeds.
  initPromise ??= (async () => {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('DATABASE_URL is required for queue initialization');
    }

    const instance = new PgBoss({
      connectionString,
      schema: 'pgboss',
      // provision-db.ts (dev/qa) and bootstrap.ts (local) create the pgboss
      // schema as a superuser before the API starts, so the runtime role
      // (api_user) never needs CREATE ON DATABASE.
      createSchema: false,
      max: 10,
      application_name: 'fluent-server-queue',
      superviseIntervalSeconds: 60,
      maintenanceIntervalSeconds: 86400,
      monitorIntervalSeconds: 60,
    });

    instance.on('error', (error: Error) => {
      logger.error('PgBoss error occurred', {
        error: error.message,
        stack: error.stack,
        name: error.name,
        code: (error as any).code,
        cause: error.cause,
      });
    });

    await instance.start();
    logger.info('PgBoss queue initialized');
    boss = instance;
    return instance;
  })().finally(() => {
    initPromise = null;
  });

  return initPromise;
}

/**
 * Runs the API-side queue boot chain (connect, then converge queues) with
 * retry-until-stopped semantics. A database flap during startup degrades
 * queue-dependent features to 503s instead of blocking the HTTP listener —
 * see ADR 0001. The standalone worker does NOT use this: a WebJob restart is
 * already its retry loop, and a worker without a queue is useless anyway.
 */
export async function initializeQueueWithRetry(isStopped: () => boolean): Promise<PgBoss | null> {
  while (!isStopped()) {
    try {
      const instance = await initializeQueue();
      await ensureExportQueues(instance);
      await ensureAiSuggestionQueue(instance);
      queueReady = true;
      logger.info('Queue ready');
      return instance;
    } catch (error) {
      logger.error('Queue initialization failed; retrying', {
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, QUEUE_INIT_RETRY_DELAY_MS));
    }
  }
  return null;
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

/**
 * True once the API boot path has started pg-boss AND converged its queues.
 * Route handlers check this to answer 503 during the post-listen init window
 * instead of catching a throw. Only `initializeQueueWithRetry` sets it — the
 * standalone worker boots through `initializeQueue` directly and gates
 * nothing on this flag.
 */
export function isQueueReady(): boolean {
  return queueReady;
}

export async function getQueue(): Promise<PgBoss> {
  if (!boss) {
    throw new Error('Queue not initialized. Call initializeQueue() first.');
  }
  return boss;
}

export async function stopQueue(): Promise<void> {
  queueReady = false;
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30000 });
    boss = null;
    logger.info('PgBoss queue stopped');
  }
}
