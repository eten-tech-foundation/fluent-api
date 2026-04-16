import { eq } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bibles } from '@/db/schema';
import { handleConstraintError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { Bible, CreateBible, UpdateBible } from './bibles.types';

export async function getAll(): Promise<Result<Bible[]>> {
  try {
    return ok(await db.select().from(bibles));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get all bibles' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getById(id: number): Promise<Result<Bible>> {
  try {
    const [bible] = await db.select().from(bibles).where(eq(bibles.id, id)).limit(1);
    if (!bible) return err(ErrorCode.BIBLE_NOT_FOUND);
    return ok(bible);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get bible by ID', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getByLanguageId(languageId: number): Promise<Result<Bible[]>> {
  try {
    return ok(await db.select().from(bibles).where(eq(bibles.languageId, languageId)));
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get bibles by language ID',
      context: { languageId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function create(data: CreateBible): Promise<Result<Bible>> {
  try {
    const [bible] = await db.insert(bibles).values(data).returning();
    if (!bible) return err(ErrorCode.INTERNAL_ERROR);
    return ok(bible);
  } catch (error) {
    return handleConstraintError(error);
  }
}

export async function update(id: number, data: UpdateBible): Promise<Result<Bible>> {
  try {
    const [bible] = await db.update(bibles).set(data).where(eq(bibles.id, id)).returning();
    if (!bible) return err(ErrorCode.BIBLE_NOT_FOUND);
    return ok(bible);
  } catch (error) {
    return handleConstraintError(error);
  }
}

export async function remove(id: number): Promise<Result<void>> {
  try {
    const [deleted] = await db.delete(bibles).where(eq(bibles.id, id)).returning({ id: bibles.id });
    if (!deleted) return err(ErrorCode.BIBLE_NOT_FOUND);
    return ok(undefined);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to delete bible', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
