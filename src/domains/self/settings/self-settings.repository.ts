import { eq, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { user_settings } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { UpsertUserSettingsInput, UserSettings } from './self-settings.types';

export interface UserSettingsRow {
  settings: UserSettings | null;
  updatedAt: Date | null;
}

export async function findByUser(userId: number): Promise<Result<UserSettingsRow | null>> {
  try {
    const [result] = await db
      .select({
        settings: user_settings.settings,
        updatedAt: user_settings.updatedAt,
      })
      .from(user_settings)
      .where(eq(user_settings.userId, userId))
      .limit(1);

    return ok(result ?? null);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to fetch user settings',
      context: { userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function upsert(input: UpsertUserSettingsInput): Promise<Result<UserSettingsRow>> {
  try {
    const [result] = await db
      .insert(user_settings)
      .values({ userId: input.userId, settings: input.settings })
      .onConflictDoUpdate({
        target: user_settings.userId,
        set: {
          settings: sql`excluded.settings`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        settings: user_settings.settings,
        updatedAt: user_settings.updatedAt,
      });

    return ok(result);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to upsert user settings',
      context: { userId: input.userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
