import type { AppError, DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';

// Carries a Result error out of the transaction callback. Throwing is the only way to
// make Drizzle roll back; this class keeps that throw inside runInTransaction so
// services never throw for business errors (see docs/guides/code-standards.md, FA-L9).
class TransactionAbort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
    this.name = 'TransactionAbort';
  }
}

/**
 * Runs `work` in a transaction that commits when it returns `ok()` and rolls back when
 * it returns `err()`. The error comes back as the Result unchanged. Unexpected
 * exceptions (driver errors, bugs) still roll back and propagate.
 *
 * Pass the caller's `tx` as `executor` to nest: Drizzle opens a savepoint, so an
 * `err()` rolls back only this unit of work.
 */
export async function runInTransaction<T>(
  work: (tx: DbTransaction) => Promise<Result<T>>,
  executor: Pick<DbTransaction, 'transaction'> = db
): Promise<Result<T>> {
  try {
    return await executor.transaction(async (tx) => {
      const result = await work(tx);
      if (!result.ok) throw new TransactionAbort(result.error);
      return result;
    });
  } catch (error) {
    if (error instanceof TransactionAbort) return { ok: false, error: error.error };
    throw error;
  }
}
