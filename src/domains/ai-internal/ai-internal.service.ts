import type {
  AiSuggestionItem,
  SuggestionContextRequest,
  SuggestionContextResponse,
} from './ai-internal.types';

import { getSuggestionContextData, upsertAiSuggestions } from './ai-internal.repository';

export const aiInternalService = {
  async getSuggestionContext(params: SuggestionContextRequest): Promise<SuggestionContextResponse> {
    const { projectUnitId, bibleId, bookCode, chapterNumber, verseStart, verseEnd } = params;

    // MAX_CONTEXT_VERSES_TOTAL = 100
    const limit = 100;

    return await getSuggestionContextData(
      projectUnitId,
      bibleId,
      bookCode,
      chapterNumber,
      verseStart, // targetVerseNumber used for FTS
      verseStart,
      verseEnd,
      limit
    );
  },

  async saveAiSuggestions(items: AiSuggestionItem[]): Promise<void> {
    await upsertAiSuggestions(items);
  },
};
