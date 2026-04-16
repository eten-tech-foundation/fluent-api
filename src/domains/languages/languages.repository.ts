import { eq } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { languages } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { Language } from './languages.types';

export async function getAll(): Promise<Result<Language[]>> {
  try {
    return ok(await db.select().from(languages));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to find all languages' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getById(id: number): Promise<Result<Language>> {
  try {
    const [language] = await db.select().from(languages).where(eq(languages.id, id));

    if (!language) return err(ErrorCode.LANGUAGE_NOT_FOUND);
    return ok(language);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to find language by ID', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
