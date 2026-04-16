import { eq } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { books, project_unit_bible_books, project_units } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ProjectBook } from './project-books.types';

export async function getBooksByProjectId(projectId: number): Promise<Result<ProjectBook[]>> {
  try {
    const projectBooks = await db
      .selectDistinct({
        book_id: books.id,
        code: books.code,
        eng_display_name: books.eng_display_name,
      })
      .from(project_units)
      .innerJoin(
        project_unit_bible_books,
        eq(project_unit_bible_books.projectUnitId, project_units.id)
      )
      .innerJoin(books, eq(books.id, project_unit_bible_books.bookId))
      .where(eq(project_units.projectId, projectId))
      .orderBy(books.id);

    const mappedBooks: ProjectBook[] = projectBooks.map((book) => ({
      bookId: book.book_id,
      code: book.code,
      engDisplayName: book.eng_display_name,
    }));

    return ok(mappedBooks);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to fetch project books',
      context: { projectId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
