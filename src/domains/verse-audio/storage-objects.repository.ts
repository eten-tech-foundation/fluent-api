import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { storage_objects, verse_audio_recordings, verse_audio_takes } from '@/db/schema';
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
 * the same object again (identical bytes reuse the hash-keyed path) revives the
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

export async function getById(id: number): Promise<Result<StorageObjectRecord>> {
  try {
    const [row] = await db
      .select()
      .from(storage_objects)
      .where(eq(storage_objects.id, id))
      .limit(1);
    if (!row) {
      return err(ErrorCode.NOT_FOUND);
    }
    return ok(row);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get storage object',
      context: { id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/** One round trip for many ids (chapter/unit URL assembly). Missing ids are omitted. */
export async function getByIds(ids: number[]): Promise<Result<StorageObjectRecord[]>> {
  if (ids.length === 0) {
    return ok([]);
  }

  try {
    const uniqueIds = [...new Set(ids)];
    const rows = await db
      .select()
      .from(storage_objects)
      .where(inArray(storage_objects.id, uniqueIds));
    return ok(rows);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get storage objects by ids',
      context: { ids },
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
 * Live objects no recording or take points at any more — the cascade-deleted case.
 *
 * `graceMs` excludes rows claimed very recently. An upload claims its row before
 * writing the object and only then writes the metadata row, so for a moment a
 * perfectly healthy upload looks orphaned; the grace period keeps the sweep off
 * anything that young.
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
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${verse_audio_takes}
            WHERE ${verse_audio_takes.storageObjectId} = ${storage_objects.id}
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

/**
 * Deletes one still-orphaned object while holding a lock on its storage row.
 *
 * The lock serializes against `claim()` and FK inserts from recordings/takes.
 * References are rechecked after the lock is acquired, immediately before the
 * bucket delete. The row is then deleted (rather than merely stamped) so a
 * blocked concurrent FK insert cannot commit a live reference to bytes that
 * were reclaimed; its request fails and can safely retry through a fresh claim.
 */
export async function reclaimOrphanIfUnreferenced(
  id: number,
  graceMs: number,
  deleteObject: (object: StorageObjectRecord) => Promise<void>
): Promise<Result<boolean>> {
  try {
    const cutoff = new Date(Date.now() - graceMs);

    return await db.transaction(async (tx) => {
      const selection = {
        id: storage_objects.id,
        bucket: storage_objects.bucket,
        key: storage_objects.key,
        createdAt: storage_objects.createdAt,
        deletedAt: storage_objects.deletedAt,
      };

      // Lock by identity first. Putting the reference predicates in this query
      // lets PostgreSQL evaluate them before a conflicting FK insert releases
      // its KEY SHARE lock, leaving a stale "unreferenced" result.
      const [locked] = await tx
        .select(selection)
        .from(storage_objects)
        .where(eq(storage_objects.id, id))
        .for('update');

      if (!locked) {
        return ok(false);
      }

      // This is intentionally a separate statement after the lock is held: all
      // orphan predicates must observe references that committed while we waited.
      const [orphan] = await tx
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
            eq(storage_objects.id, id),
            isNull(storage_objects.deletedAt),
            lt(storage_objects.createdAt, cutoff),
            sql`NOT EXISTS (
              SELECT 1 FROM ${verse_audio_recordings}
              WHERE ${verse_audio_recordings.storageObjectId} = ${storage_objects.id}
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM ${verse_audio_takes}
              WHERE ${verse_audio_takes.storageObjectId} = ${storage_objects.id}
            )`
          )
        )
        .limit(1);

      if (!orphan) {
        return ok(false);
      }

      await deleteObject(orphan);
      const deleted = await tx
        .delete(storage_objects)
        .where(eq(storage_objects.id, orphan.id))
        .returning({ id: storage_objects.id });

      return ok(deleted.length === 1);
    });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to reclaim orphaned storage object',
      context: { id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
