/**
 * Pinned pg-boss 12.1.1 schema. The dead-letter monitor and the queue policy
 * migration both read raw `pgboss.*` tables, so a schema bump has to move them
 * together instead of silently disabling one of them.
 */
export const PG_BOSS_SCHEMA_VERSION = 26;
