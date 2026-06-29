import { requireServiceAuth } from '@/middlewares/service-auth';
import { server } from '@/server/server';

import { aiInternalService } from './ai-internal.service';
import {
  suggestionContextRequestSchema,
  upsertAiSuggestionsRequestSchema,
} from './ai-internal.types';

// Note: These routes use server.post directly instead of createRoute
// to avoid exposing them in the public OpenAPI schema.

server.post('/internal/suggestion-context', requireServiceAuth, async (c) => {
  try {
    const body = await c.req.json();
    const parsedBody = suggestionContextRequestSchema.parse(body);

    const data = await aiInternalService.getSuggestionContext(parsedBody);

    return c.json(data);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ message: 'Validation failed', errors: error.errors }, 400);
    }
    return c.json({ message: error.message }, 500);
  }
});

server.post('/internal/ai-suggestions', requireServiceAuth, async (c) => {
  try {
    const body = await c.req.json();
    const parsedBody = upsertAiSuggestionsRequestSchema.parse(body);

    await aiInternalService.saveAiSuggestions(parsedBody.items);
    return c.json({ success: true }, 200);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return c.json({ message: 'Validation failed', errors: error.errors }, 400);
    }
    return c.json({ message: error.message }, 500);
  }
});
