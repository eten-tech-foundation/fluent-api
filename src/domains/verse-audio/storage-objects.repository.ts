import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { storage_objects, verse_audio_recordings } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

export interface StorageObjectRecord {
  id: number;
  bucket: string;
  key: string;
  createdAt: Date;
  deletedAt: Date | null;
}

/**
 * Records that `key` exists in `bucket`, returning the row. Idempotent: writing
 * the same object again (a re-recording overwrites in place) revives the
 * existing row rather than adding a second one, so the sweep never sees a
 * duplicate for the same bytes.
 */
export async function claim(bucket: string, key: string): Promise<Result<StorageObjectRecord>> {
  try {
    const [row] = await db
      .insert(storage_objects)
      .values({ bucket, key })
      .onConflictDoUpdate({
        target: [storage_objects.bucket, storage_objects.key],
        // createdAt is refreshed as well as deletedAt cleared: it is what the
        // reclaim grace period keys off, so a revived row must look new. Without
        // this, a sweep running between claim and the metadata write could treat
        // a freshly re-uploaded object as a long-dead orphan and delete it.
        set: { deletedAt: null, createdAt: new Date() },
      })
      .returning();

    return ok(row);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to claim storage object',
      context: { bucket, key },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/** Stamps deletedAt once the object is actually gone from the bucket. */
export async function markDeleted(id: number): Promise<Result<void>> {
  try {
    await db
      .update(storage_objects)
      .set({ deletedAt: new Date() })
      .where(eq(storage_objects.id, id));
    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to mark storage object deleted',
      context: { id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Live objects no recording points at any more — the cascade-deleted case. These
 * are exactly the rows whose bytes are still sitting in the bucket with nothing
 * referencing them.
 *
 * `graceMs` excludes rows claimed very recently. An upload claims its row before
 * writing the object and only then writes the metadata row, so for a moment a
 * perfectly healthy upload looks orphaned; the grace period keeps the sweep off
 * anything that young. Legitimately orphaned rows (a dropped project unit, a
 * crashed upload) simply get collected on a later pass.
 */
export async function findOrphans(
  graceMs: number,
  limit = 500
): Promise<Result<StorageObjectRecord[]>> {
  try {
    const rows = await db
      .select({
        id: storage_objects.id,
        bucket: storage_objects.bucket,
        key: storage_objects.key,
        createdAt: storage_objects.createdAt,
        deletedAt: storage_objects.deletedAt,
      })
      .from(storage_objects)
      .where(
        and(
          isNull(storage_objects.deletedAt),
          lt(storage_objects.createdAt, new Date(Date.now() - graceMs)),
          sql`NOT EXISTS (
            SELECT 1 FROM ${verse_audio_recordings}
            WHERE ${verse_audio_recordings.storageObjectId} = ${storage_objects.id}
          )`
        )
      )
      .limit(limit);

    return ok(rows);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to list orphaned storage objects' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
