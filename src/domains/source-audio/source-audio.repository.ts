import { and, eq } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { books, project_unit_bible_books, project_units } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

/**
 * Check that a Bible/book pair is linked to a unit in the authorized project.
 * This prevents project-scoped routes from accepting unrelated Bible IDs.
 */
export async function isBibleBookLinkedToProject(
  projectId: number,
  bibleId: number,
  bookCode: string
): Promise<Result<boolean>> {
  try {
    const [link] = await db
      .select({ bibleId: project_unit_bible_books.bibleId })
      .from(project_unit_bible_books)
      .innerJoin(project_units, eq(project_units.id, project_unit_bible_books.projectUnitId))
      .innerJoin(books, eq(books.id, project_unit_bible_books.bookId))
      .where(
        and(
          eq(project_units.projectId, projectId),
          eq(project_unit_bible_books.bibleId, bibleId),
          eq(books.code, bookCode)
        )
      )
      .limit(1);

    return ok(Boolean(link));
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to verify project source Bible',
      context: { projectId, bibleId, bookCode },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
