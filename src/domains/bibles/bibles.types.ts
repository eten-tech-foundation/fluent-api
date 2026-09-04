import { z } from '@hono/zod-openapi';

import type { insertBiblesSchema, patchBiblesSchema, selectBiblesSchema } from '@/db/schema';

// ─── DB-derived types ─────────────────────────────────────────────

export type Bible = z.infer<typeof selectBiblesSchema>;
export type CreateBible = z.infer<typeof insertBiblesSchema>;
export type UpdateBible = z.infer<typeof patchBiblesSchema>;

export const bibleResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  abbreviation: z.string(),
  languageId: z.number().int(),
  provider: z.string(),
});

export type BibleResponse = z.infer<typeof bibleResponseSchema>;

export const sourceSearchLanguageItemSchema = z.object({
  id: z.number().int(),
  langName: z.string(),
  langCodeIso6393: z.string().nullable(),
  bibleCount: z.number().int(),
  bibles: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      abbreviation: z.string(),
      provider: z.string(),
    })
  ),
});

export const sourceSearchBibleItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  abbreviation: z.string(),
  provider: z.string(),
  languageId: z.number().int(),
  languageName: z.string(),
  languageCode: z.string().nullable(),
});

export const sourceSearchResponseSchema = z.object({
  languages: z.array(sourceSearchLanguageItemSchema),
  bibles: z.array(sourceSearchBibleItemSchema),
});

export type SourceSearchResponse = z.infer<typeof sourceSearchResponseSchema>;
export type SourceSearchLanguageItem = z.infer<typeof sourceSearchLanguageItemSchema>;
export type SourceSearchBibleItem = z.infer<typeof sourceSearchBibleItemSchema>;
