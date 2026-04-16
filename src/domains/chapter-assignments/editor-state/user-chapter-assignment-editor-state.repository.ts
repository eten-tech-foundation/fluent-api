import { and, eq, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { user_chapter_assignment_editor_state } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  EditorStateResources,
  UpsertEditorStateInput,
} from './user-chapter-assignment-editor-state.types';

export async function findByUserAndAssignment(
  userId: number,
  chapterAssignmentId: number
): Promise<Result<EditorStateResources>> {
  try {
    const [result] = await db
      .select({ resources: user_chapter_assignment_editor_state.resources })
      .from(user_chapter_assignment_editor_state)
      .where(
        and(
          eq(user_chapter_assignment_editor_state.userId, userId),
          eq(user_chapter_assignment_editor_state.chapterAssignmentId, chapterAssignmentId)
        )
      )
      .limit(1);

    return ok(result?.resources ?? null);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to fetch editor state',
      context: { userId, chapterAssignmentId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function upsert(input: UpsertEditorStateInput): Promise<Result<EditorStateResources>> {
  try {
    const [result] = await db
      .insert(user_chapter_assignment_editor_state)
      .values(input)
      .onConflictDoUpdate({
        target: [
          user_chapter_assignment_editor_state.userId,
          user_chapter_assignment_editor_state.chapterAssignmentId,
        ],
        set: {
          resources: sql`excluded.resources`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ resources: user_chapter_assignment_editor_state.resources });

    return ok(result.resources);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to upsert editor state', context: { input } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
