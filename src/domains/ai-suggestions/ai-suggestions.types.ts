import { z } from '@hono/zod-openapi';

export const getAiSuggestionsQuerySchema = z.object({
  projectUnitId: z.coerce.number().int().positive(),
  bibleTextIds: z
    .string()
    .regex(/^\d+(,\d+)*$/, 'Expected comma-separated numeric bible text IDs')
    .describe('Comma-separated list of bible text IDs')
    .transform((val) => val.split(',').map((id) => Number.parseInt(id.trim(), 10))),
});

export type GetAiSuggestionsQuery = z.infer<typeof getAiSuggestionsQuerySchema>;

export const aiSuggestionResponseSchema = z.object({
  bibleTextId: z.number().int(),
  suggestedText: z.string(),
  modelInfo: z.string().nullable().optional(),
});

export const aiSuggestionsListResponseSchema = z.object({
  data: z.array(aiSuggestionResponseSchema),
});

export type AiSuggestionsListResponse = z.infer<typeof aiSuggestionsListResponseSchema>;

export const queueNextVersesRequestSchema = z.object({
  projectUnitId: z.number().int().positive(),
  bibleId: z.number().int().positive(),
  bookCode: z.string(),
  chapterNumber: z.number().int().positive(),
  currentVerse: z.number().int().positive(),
});

export type QueueNextVersesRequest = z.infer<typeof queueNextVersesRequestSchema>;

export const queueNextVersesResponseSchema = z.object({
  queued: z.boolean(),
  thresholdMet: z.boolean(),
});

export type QueueNextVersesResponse = z.infer<typeof queueNextVersesResponseSchema>;

export const trackUsageRequestSchema = z.object({
  bibleTextId: z.number().int().positive(),
  projectUnitId: z.number().int().positive(),
  wasUsed: z.boolean(),
});

export type TrackUsageRequest = z.infer<typeof trackUsageRequestSchema>;

// ─── Internal (machine-facing) schemas ────────────────────────────────────────

export const suggestionContextRequestSchema = z.object({
  projectUnitId: z.number().int().positive(),
  bibleId: z.number().int().positive(),
  bookCode: z.string().min(3).max(4),
  chapterNumber: z.number().int().positive(),
  verseStart: z.number().int().positive(),
  verseEnd: z.number().int().positive(),
});

export type SuggestionContextRequest = z.infer<typeof suggestionContextRequestSchema>;

export const aiSuggestionItemSchema = z.object({
  bibleTextId: z.number().int().positive(),
  projectUnitId: z.number().int().positive(),
  suggestedText: z.string(),
  modelInfo: z.string().nullable().optional(),
});

export type AiSuggestionItem = z.infer<typeof aiSuggestionItemSchema>;

export const upsertAiSuggestionsRequestSchema = z.object({
  items: z.array(aiSuggestionItemSchema),
});

export type UpsertAiSuggestionsRequest = z.infer<typeof upsertAiSuggestionsRequestSchema>;

export interface ContextVerse {
  verse_id: string;
  source_text: string;
  target_text: string;
}

export interface SourceVerse {
  id: number;
  verse_number: number;
  text: string;
}

export interface SuggestionContextResponse {
  targetLanguageName: string;
  contextVerses: ContextVerse[];
  sourceVerses: SourceVerse[];
}
