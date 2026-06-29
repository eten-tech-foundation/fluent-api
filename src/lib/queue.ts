import { PgBoss } from 'pg-boss';

import { logger } from '@/lib/logger';

let boss: PgBoss | null = null;

export const QUEUE_NAMES = {
  USFM_EXPORT: 'usfm-export',
  AI_SUGGESTION_TRIGGER: 'ai-suggestion-trigger',
} as const;

export interface USFMExportJob {
  projectUnitId: number;
  bookIds?: number[];
  requestedBy?: string;
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
