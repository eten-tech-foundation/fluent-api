import type { Result } from '@/lib/types';

import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  ChapterPericopesResponse,
  PericopeSet,
  PericopeSetResponse,
  PericopeVerseRow,
} from './pericopes.types';

import { groupPericopeVerses } from './pericopes.grouping';
import * as repo from './pericopes.repository';

export async function listPericopeSets(): Promise<Result<PericopeSet[]>> {
  try {
    const sets = await repo.getAllPericopeSets();
    return ok(sets);
  } catch (error) {
    logger.error('Failed to list pericope sets', { error });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getPericopeSet(
  id: number,
  bookCode?: string
): Promise<Result<PericopeSetResponse>> {
  try {
    const set = await repo.getPericopeSetById(id);
    if (!set) return err(ErrorCode.PERICOPE_SET_NOT_FOUND);

    let bookId: number | undefined;
    if (bookCode !== undefined) {
      const resolvedBookId = await repo.getBookIdByCode(bookCode);
      if (resolvedBookId === null) return err(ErrorCode.BOOK_NOT_FOUND);
      bookId = resolvedBookId;
    }

    const rows = await repo.getPericopeVersesForSet(id, bookId);
    const books = new Map<number, { bookCode: string; rows: PericopeVerseRow[] }>();
    for (const row of rows) {
      if (!books.has(row.bookId)) {
        books.set(row.bookId, { bookCode: row.bookCode, rows: [] });
      }
      books.get(row.bookId)!.rows.push(row);
    }

    return ok(
      Array.from(books.values()).flatMap((book) =>
        groupPericopeVerses(book.rows).map((group) => ({ bookCode: book.bookCode, ...group }))
      )
    );
  } catch (error) {
    logger.error('Failed to get pericope set', { error, id, bookCode });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getChapterPericopes(
  projectId: number,
  bookCode: string,
  chapter: number,
  includeFullPericopes = false
): Promise<Result<ChapterPericopesResponse>> {
  try {
    // 1. Get project's pericope set — if null, return empty (verse-by-verse fallback)
    const pericopeSetId = await repo.getPericopeSetIdForProject(projectId);
    if (!pericopeSetId) return ok([]);

    // 2. Resolve bookCode to book_id
    const bookId = await repo.getBookIdByCode(bookCode);
    if (!bookId) return err(ErrorCode.BOOK_NOT_FOUND);

    // 3. Optionally include complete references for groups touching this chapter.
    const rows = await repo.getPericopeVersesForChapter(
      pericopeSetId,
      bookId,
      chapter,
      includeFullPericopes
    );

    // 4. No rows = book not covered in this set → verse-by-verse fallback
    if (rows.length === 0) return ok([]);

    return ok(groupPericopeVerses(rows));
  } catch (error) {
    logger.error('Failed to get chapter pericopes', {
      error,
      projectId,
      bookCode,
      chapter,
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
