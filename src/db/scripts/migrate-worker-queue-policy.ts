import postgres from 'postgres';

import { migrateExclusiveWorkerQueue } from '@/lib/exclusive-worker-queue-migration';

const [queueName, mode, ...extra] = process.argv.slice(2);
if (!queueName || (mode && mode !== '--apply') || extra.length) {
  throw new Error('Usage: npm run queue:migrate-policy -- <usfm-export|ai-suggestions> [--apply]');
}
// Deliberately do not load .env or fall back to the application's DATABASE_URL.
const connectionString = process.env.WORKER_QUEUE_MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_QUEUE_MIGRATION_DATABASE_URL is required');

const sql = postgres(connectionString, { max: 1, connect_timeout: 5 });
try {
  const result = await migrateExclusiveWorkerQueue(sql, queueName, mode === '--apply');
  console.log(JSON.stringify({ mode: mode === '--apply' ? 'apply' : 'inspect', ...result }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Worker queue policy migration failed');
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
