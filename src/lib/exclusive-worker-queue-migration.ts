import type postgres from 'postgres';

const MIGRATABLE_QUEUES = ['usfm-export', 'ai-suggestions'];

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
    if (apply) {
      // Includes all partitions. No sender, worker or maintenance process can
      // change jobs between the pending-work check and the policy update.
      await tx`LOCK TABLE pgboss.queue, pgboss.job IN ACCESS EXCLUSIVE MODE`;
    }
    const [version] = await tx`SELECT version FROM pgboss.version`;
    if (version?.version !== 26) {
      throw new Error('Migration requires the pg-boss 12.1.1 schema version 26');
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
    const result = {
      queueName,
      previousPolicy: queue.policy as string,
      retainedJobs: stats.retained as number,
      pendingJobs: stats.pending as number,
      changed: false,
    };
    if (!apply || queue.policy === 'exclusive') return result;
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
