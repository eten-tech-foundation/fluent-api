import { and, asc, eq, lt } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { active_chapter_editors, users } from '@/db/schema';
import { STALE_THRESHOLD_MINUTES } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { PresenceResponse } from './chapter-assignments-presence.types';

export async function upsertAndQueryFirstEditor(
  userId: number,
  chapterAssignmentId: number
): Promise<Result<PresenceResponse>> {
  try {
    return await db.transaction(async (tx) => {
      const now = new Date();
      const staleTime = new Date(now.getTime() - STALE_THRESHOLD_MINUTES * 60 * 1000);

      // Prune stale editors
      await tx
        .delete(active_chapter_editors)
        .where(
          and(
            eq(active_chapter_editors.chapterAssignmentId, chapterAssignmentId),
            lt(active_chapter_editors.lastHeartbeat, staleTime)
          )
        );

      // Upsert current user's heartbeat
      await tx
        .insert(active_chapter_editors)
        .values({ userId, chapterAssignmentId, startedAt: now, lastHeartbeat: now })
        .onConflictDoUpdate({
          target: [active_chapter_editors.chapterAssignmentId, active_chapter_editors.userId],
          set: { lastHeartbeat: now },
        });

      // Determine who arrived first
      const [firstEditor] = await tx
        .select({
          userId: active_chapter_editors.userId,
          username: users.username,
          startedAt: active_chapter_editors.startedAt,
        })
        .from(active_chapter_editors)
        .innerJoin(users, eq(active_chapter_editors.userId, users.id))
        .where(eq(active_chapter_editors.chapterAssignmentId, chapterAssignmentId))
        .orderBy(asc(active_chapter_editors.startedAt))
        .limit(1);

      if (!firstEditor) {
        throw new Error('No editor record found after upsert — this should not happen');
      }

      const isFirst = firstEditor.userId === userId;
      return ok({
        isFirstEditor: isFirst,
        firstEditorName: isFirst ? null : firstEditor.username,
      });
    });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to register presence',
      context: { userId, chapterAssignmentId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function deleteByUserAndAssignment(
  userId: number,
  chapterAssignmentId: number
): Promise<Result<void>> {
  try {
    await db
      .delete(active_chapter_editors)
      .where(
        and(
          eq(active_chapter_editors.userId, userId),
          eq(active_chapter_editors.chapterAssignmentId, chapterAssignmentId)
        )
      );
    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to remove presence',
      context: { userId, chapterAssignmentId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
