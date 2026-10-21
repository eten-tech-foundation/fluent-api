import type { PgBoss } from 'pg-boss';

/** Count pending rows once, including delayed retries, using the configured pg-boss schema. */
export async function countPendingQueueJobs(boss: PgBoss, queueName: string): Promise<number> {
  // pg-boss 12.1.1 getQueueStats can retain cached counters when its grouped query
  // returns no rows. An aggregate without GROUP BY always reports zero after drain.
  const { rows } = await boss.getDb().executeSql(
    `SELECT count(*)::int AS count FROM pgboss.job
     WHERE name = $1 AND state IN ('created', 'retry', 'active')`,
    [queueName]
  );
  return rows[0].count;
}
