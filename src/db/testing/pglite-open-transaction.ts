import type { PgliteDatabase } from 'drizzle-orm/pglite';

/**
 * For PGlite tests of services that read through `db` while their own transaction is open.
 * PGlite has a single connection, so such a read waits for the transaction forever. Through
 * this wrapper it joins the open transaction instead. The transaction itself stays real, so a
 * rollback still discards every write made in it.
 */
export function joinOpenTransaction<TSchema extends Record<string, unknown>>(
  database: PgliteDatabase<TSchema>
): PgliteDatabase<TSchema> {
  let open: object | null = null;
  return new Proxy(database, {
    get(target, prop) {
      if (prop === 'transaction') {
        return (callback: (tx: unknown) => Promise<unknown>) =>
          target.transaction(async (tx) => {
            open = tx;
            try {
              return await callback(tx);
            } finally {
              open = null;
            }
          });
      }
      const connection = open ?? target;
      const value: unknown = Reflect.get(connection, prop);
      return typeof value === 'function' ? value.bind(connection) : value;
    },
  });
}
