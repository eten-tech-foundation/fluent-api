import { getHttpStatus } from '@/lib/types';
import { requireServiceAuth } from '@/middlewares/service-auth';
import { server } from '@/server/server';

import * as aiSuggestionsService from './ai-suggestions.service';
import {
  suggestionContextRequestSchema,
  upsertAiSuggestionsRequestSchema,
} from './ai-suggestions.types';

// Note: These routes use server.post directly instead of createRoute
// to avoid exposing them in the public OpenAPI schema.
// They are machine-facing endpoints called exclusively by fluent-ai's
// suggestion_processor worker, authenticated via service key.

server.post('/ai-suggestions/internal/context', requireServiceAuth, async (c) => {
  const body = await c.req.json();
  const parsed = suggestionContextRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ message: 'Validation failed', errors: parsed.error.errors }, 400);
  }

  const result = await aiSuggestionsService.getSuggestionContext(parsed.data);

  if (result.ok) {
    return c.json(result.data, 200);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});

server.post('/ai-suggestions/internal/results', requireServiceAuth, async (c) => {
  const body = await c.req.json();
  const parsed = upsertAiSuggestionsRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ message: 'Validation failed', errors: parsed.error.errors }, 400);
  }

  const result = await aiSuggestionsService.saveAiSuggestions(parsed.data.items);

  if (result.ok) {
    return c.json({ success: true }, 200);
  }

  return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
});
