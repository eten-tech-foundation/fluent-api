import { eq, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { user_settings } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { MergeUserSettingsInput, UserSettings } from './self-settings.types';

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

/**
 * Atomically shallow-merge `patch` into the user's settings JSONB blob.
 *
 * - Insert path: store `jsonb_strip_nulls(patch)` (nulls never persist).
 * - Update path: `jsonb_strip_nulls(COALESCE(existing, {}) || patch)` so
 *   concurrent different-key writers retain each other's keys and an explicit
 *   JSON `null` deletes that key (service validation allows null only for
 *   `displayMode`). Uses one upsert statement — not a JS read/merge/write —
 *   including first-row creation races.
 */
export async function mergePatch(input: MergeUserSettingsInput): Promise<Result<UserSettingsRow>> {
  const patchJson = JSON.stringify(input.patch);

  try {
    const [result] = await db
      .insert(user_settings)
      .values({
        userId: input.userId,
        // Bound JSON text → jsonb, strip deletion-nulls for the insert row.
        settings: sql`jsonb_strip_nulls(${patchJson}::jsonb)`,
      })
      .onConflictDoUpdate({
        target: user_settings.userId,
        set: {
          // Must merge the raw patch (nulls intact), not excluded.settings —
          // the insert values already strip nulls, which would lose deletes.
          settings: sql`jsonb_strip_nulls(COALESCE(${user_settings.settings}, '{}'::jsonb) || ${patchJson}::jsonb)`,
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
      message: 'Failed to merge user settings',
      context: { userId: input.userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
