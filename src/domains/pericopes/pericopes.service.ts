import type { Result } from '@/lib/types';

import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ChapterPericopesResponse, PericopeSet } from './pericopes.types';

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

export async function getChapterPericopes(
  projectId: number,
  bookCode: string,
  chapter: number
): Promise<Result<ChapterPericopesResponse>> {
  try {
    // 1. Get project's pericope set — if null, return empty (verse-by-verse fallback)
    const pericopeSetId = await repo.getPericopeSetIdForProject(projectId);
    if (!pericopeSetId) return ok([]);

    // 2. Resolve bookCode to book_id
    const bookId = await repo.getBookIdByCode(bookCode);
    if (!bookId) return err(ErrorCode.BOOK_NOT_FOUND);

    // 3. Fetch all pericope verse rows for this chapter
    const rows = await repo.getPericopeVersesForChapter(pericopeSetId, bookId, chapter);

    // 4. No rows = book not covered in this set → verse-by-verse fallback
    if (rows.length === 0) return ok([]);

    // 5. Group rows by section + pericope_number in application layer if section is present (FCBH)
    const groupMap = new Map<string, ChapterPericopesResponse[number]>();
    for (const row of rows) {
      const groupKey =
        row.section !== null ? `${row.section}_${row.pericopeNumber}` : row.pericopeNumber;
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          pericopeNumber: groupKey,
          pericopeTitle: row.pericopeTitle ?? null,
          verses: [],
        });
      }
      groupMap.get(groupKey)!.verses.push({
        chapterNumber: row.chapterNumber,
        verseNumber: row.verseNumber,
      });
    }

    return ok(Array.from(groupMap.values()));
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
