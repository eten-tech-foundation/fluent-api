import type postgres from 'postgres';

import { PG_BOSS_SCHEMA_VERSION } from '@/lib/pg-boss-schema';
import { QUEUE_NAMES } from '@/lib/queue';

const MIGRATABLE_QUEUES: string[] = [QUEUE_NAMES.USFM_EXPORT, QUEUE_NAMES.AI_SUGGESTIONS];

/** Offline, operator-invoked migration for the pinned pg-boss 12.1.1 schema. */
export async function migrateExclusiveWorkerQueue(
  sql: postgres.Sql,
  queueName: string,
  apply = false
) {
  if (!MIGRATABLE_QUEUES.includes(queueName)) {
    throw new Error('Only usfm-export and ai-suggestions can be migrated');
  }

  return sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    const readQueueState = async () => {
      const [version] = await tx`SELECT version FROM pgboss.version`;
      if (version?.version !== PG_BOSS_SCHEMA_VERSION) {
        throw new Error(
          `Migration requires the pg-boss 12.1.1 schema version ${PG_BOSS_SCHEMA_VERSION}`
        );
      }
      const [queue] = await tx`
        SELECT policy, partition, table_name FROM pgboss.queue WHERE name = ${queueName}
      `;
      if (!queue) throw new Error(`Queue ${queueName} does not exist`);

      const [stats] = await tx`
        SELECT count(*)::int AS retained,
               count(*) FILTER (WHERE state <= 'active')::int AS pending
          FROM pgboss.job WHERE name = ${queueName}
      `;
      return {
        queue,
        result: {
          queueName,
          previousPolicy: queue.policy as string,
          retainedJobs: stats.retained as number,
          pendingJobs: stats.pending as number,
          changed: false,
        },
      };
    };

    // Read the policy before locking. An inspection, or a re-run after a
    // successful migration, must not stall every queue's fetch/complete/send
    // for the lock timeout just to discover there is nothing to do.
    const preflight = await readQueueState();
    if (!apply || preflight.queue.policy === 'exclusive') return preflight.result;

    // Includes all partitions. No sender, worker or maintenance process can
    // change jobs between the pending-work check and the policy update.
    await tx`LOCK TABLE pgboss.queue, pgboss.job IN ACCESS EXCLUSIVE MODE`;
    // The unlocked pre-check can race another migration, so decide again on the
    // state this lock now protects.
    const { queue, result } = await readQueueState();
    if (queue.policy === 'exclusive') return result;
    if (result.pendingJobs > 0) {
      throw new Error(
        `${queueName} still has ${result.pendingJobs} queued, deferred or active jobs`
      );
    }

    if (queue.partition) {
      // Dedicated partitions only have the index for their original policy.
      // Match pg-boss 12.1.1's exclusive index; identifiers are quoted by postgres.
      await tx`
        CREATE UNIQUE INDEX ${tx(`${queue.table_name}_i6`)}
          ON ${tx(`pgboss.${queue.table_name}`)} (name, COALESCE(singleton_key, ''))
          WHERE state <= 'active' AND policy = 'exclusive'
      `;
    } else {
      // The shared partition already has every policy index in schema 26.
      const [index] = await tx`
        SELECT indisvalid AND indisunique AS valid FROM pg_index
        WHERE indexrelid = to_regclass('pgboss.job_i6')
          AND indrelid = to_regclass('pgboss.job_common')
      `;
      if (!index?.valid) throw new Error('The pg-boss exclusive index is missing or invalid');
    }
    await tx`UPDATE pgboss.queue SET policy = 'exclusive' WHERE name = ${queueName}`;
    // Keep IDs, payloads, errors, states, retry counters, routing and deadlines.
    // Updating historical policy also enforces dedupe if a job is later retried.
    await tx`UPDATE pgboss.job SET policy = 'exclusive' WHERE name = ${queueName}`;
    return { ...result, changed: true };
  });
}
