import type {
  YouVersionBible,
  YouVersionChapterText,
} from '@/lib/services/youversion/youversion.types';
import type { Result } from '@/lib/types';

import * as youVersionClient from '@/lib/services/youversion/youversion.client';

export async function getBibles(languageTag: string): Promise<Result<YouVersionBible[]>> {
  return youVersionClient.getBibles(languageTag);
}

export async function getChapterText(
  bibleId: number,
  bookId: string,
  chapterId: number
): Promise<Result<YouVersionChapterText>> {
  return youVersionClient.getChapterText(bibleId, bookId, chapterId);
}
