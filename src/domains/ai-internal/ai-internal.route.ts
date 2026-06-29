import { server } from '@/server/server';
import { requireServiceAuth } from '@/middlewares/service-auth';
import { getSuggestionContextData, upsertAiSuggestions } from './ai-internal.repository';

// Note: These routes use server.post directly instead of createRoute 
// to avoid exposing them in the public OpenAPI schema.

server.post('/internal/suggestion-context', requireServiceAuth, async (c) => {
  const body = await c.req.json();
  const { projectUnitId, bibleId, bookCode, chapterNumber, verseStart, verseEnd } = body;

  try {
    const data = await getSuggestionContextData(
      projectUnitId,
      bibleId,
      bookCode,
      chapterNumber,
      verseStart, // targetVerseNumber used for FTS
      verseStart,
      verseEnd,
      100 // MAX_CONTEXT_VERSES_TOTAL
    );

    return c.json(data);
  } catch (error: any) {
    return c.json({ message: error.message }, 500);
  }
});

server.post('/internal/ai-suggestions', requireServiceAuth, async (c) => {
  const body = await c.req.json();
  const { items } = body;

  try {
    await upsertAiSuggestions(items);
    return c.json({ success: true }, 200);
  } catch (error: any) {
    return c.json({ message: error.message }, 500);
  }
});
