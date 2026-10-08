/**
 * Shared postgres.js helpers for db scripts (provision-db.ts, reset-db.ts):
 * server-side identifier/literal quoting so DDL built with sql.unsafe is
 * injection-safe.
 */
import type postgres from 'postgres';

export type Sql = postgres.Sql;

/** Returns a server-side-quoted identifier (safe against injection). */
export async function ident(sql: Sql, name: string): Promise<string> {
  const [row] = await sql`SELECT quote_ident(${name}) AS q`;
  return row.q as string;
}

/** Returns a server-side-quoted string literal (safe against injection). */
export async function literal(sql: Sql, value: string): Promise<string> {
  const [row] = await sql`SELECT quote_literal(${value}) AS q`;
  return row.q as string;
}
