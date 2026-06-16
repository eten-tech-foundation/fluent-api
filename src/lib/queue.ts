import { PgBoss } from 'pg-boss';

import { logger } from '@/lib/logger';

let boss: PgBoss | null = null;

export const QUEUE_NAMES = {
  USFM_EXPORT: 'usfm-export',
} as const;

export interface USFMExportJob {
  projectUnitId: number;
  bookIds?: number[];
  requestedBy?: string;
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
