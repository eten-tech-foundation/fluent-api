import { z } from '@hono/zod-openapi';

import env from '@/env';

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
  bookCode: z.string().min(3).max(3),
  chapterNumber: z.number().int().positive(),
  currentVerse: z.number().int().positive(),
  lookahead: z.number().int().positive().max(20).default(env.AI_DEFAULT_LOOKAHEAD),
});

export type QueueNextVersesRequest = z.infer<typeof queueNextVersesRequestSchema>;

export const trackUsageRequestSchema = z.object({
  bibleTextId: z.number().int().positive(),
  projectUnitId: z.number().int().positive(),
  wasUsed: z.boolean(),
});

export type TrackUsageRequest = z.infer<typeof trackUsageRequestSchema>;
