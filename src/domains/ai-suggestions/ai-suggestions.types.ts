import { z } from '@hono/zod-openapi';

import { verseHeadingSchema } from '@/db/schema';

export const pericopeNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^,]+$/);
const pericopeNumbersSchema = z
  .array(pericopeNumberSchema)
  .min(1)
  .max(2)
  .refine((values) => new Set(values).size === values.length, 'Duplicate pericope numbers');
export const pericopeRequestSchema = z.object({
  projectUnitId: z.number().int().positive(),
  bibleId: z.number().int().positive(),
  bookCode: z
    .string()
    .trim()
    .min(3)
    .max(4)
    .transform((value) => value.toUpperCase()),
  chapterNumber: z.number().int().positive(),
  pericopeNumbers: pericopeNumbersSchema,
});
export type PericopeRequest = z.infer<typeof pericopeRequestSchema>;
export const pericopeQuerySchema = pericopeRequestSchema.extend({
  projectUnitId: z.coerce.number().int().positive(),
  bibleId: z.coerce.number().int().positive(),
  chapterNumber: z.coerce.number().int().positive(),
  pericopeNumbers: z
    .string()
    .max(201)
    .transform((value) => value.split(','))
    .pipe(pericopeNumbersSchema),
});
export const pericopeSuggestionResponseSchema = z.object({
  pericopeNumber: pericopeNumberSchema,
  bibleTextId: z.number().int().positive(),
  suggestedText: verseHeadingSchema.shape.text,
  modelInfo: z.string().max(100).nullable().optional(),
});
export const pericopeSuggestionsResponseSchema = z.object({
  data: z.array(pericopeSuggestionResponseSchema),
});
export type PericopeSuggestionsResponse = z.infer<typeof pericopeSuggestionsResponseSchema>;
export const pericopeUsageRequestSchema = z.object({
  projectUnitId: z.number().int().positive(),
  bibleTextId: z.number().int().positive(),
  pericopeNumber: pericopeNumberSchema,
  wasUsed: z.boolean(),
});
export type PericopeUsageRequest = z.infer<typeof pericopeUsageRequestSchema>;
export const pericopeSuggestionItemSchema = pericopeSuggestionResponseSchema.extend({
  projectUnitId: z.number().int().positive(),
  pericopeSetId: z.number().int().positive(),
});
export type PericopeSuggestionItem = z.infer<typeof pericopeSuggestionItemSchema>;

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
  pericopeNumber: pericopeNumberSchema.optional(),
  pericopeSetId: z.number().int().positive().optional(),
});

export type SuggestionContextRequest = z.infer<typeof suggestionContextRequestSchema>;

export const aiSuggestionItemSchema = z.object({
  bibleTextId: z.number().int().positive(),
  projectUnitId: z.number().int().positive(),
  suggestedText: z.string(),
  modelInfo: z.string().nullable().optional(),
});

export type AiSuggestionItem = z.infer<typeof aiSuggestionItemSchema>;

export const upsertAiSuggestionsRequestSchema = z
  .object({
    items: z.array(aiSuggestionItemSchema),
    heading: pericopeSuggestionItemSchema.optional(),
  })
  .refine(
    (value) => !value.heading || value.items.length === 0,
    'A heading-only result cannot contain scripture items'
  );

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
  sectionHeading?: {
    pericopeNumber: string;
    pericopeSetId: number;
    bibleTextId: number;
    sourceTitle: string;
  } | null;
}
