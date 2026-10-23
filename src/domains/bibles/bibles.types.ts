import { z } from '@hono/zod-openapi';

import type { insertBiblesSchema, patchBiblesSchema, selectBiblesSchema } from '@/db/schema';

import { ttsLicenseStatusEnum } from '@/db/schema';

export const ttsLicenseStatusSchema = z.enum(ttsLicenseStatusEnum.enumValues);
export type TtsLicenseStatus = z.infer<typeof ttsLicenseStatusSchema>;

// ─── DB-derived types ─────────────────────────────────────────────

export type Bible = z.infer<typeof selectBiblesSchema>;
export type CreateBible = z.infer<typeof insertBiblesSchema>;
export type UpdateBible = z.infer<typeof patchBiblesSchema>;

export const bibleResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  abbreviation: z.string(),
  languageId: z.number().int(),
  hasAudio: z.boolean(),
  provider: z.string(),
  ttsLicenseStatus: ttsLicenseStatusSchema.optional(),
  textBibleKey: z.string().nullable(),
  selectedRecordingKey: z.string().nullable(),
  updatedAt: z.string().datetime().nullable().openapi({
    description:
      'Server watermark for this bible row (advanced via next_catalogue_watermark() when the bible row changes, when a linked provider-resource license/display/identity column is inserted or changed via DB trigger, or when audioResourceId changes via $onUpdate). Clients must use max(updatedAt) across a successful non-empty list as the next updatedAfter cursor; empty lists must not advance the cursor. Device wall-clock cursors can skip rows.',
  }),
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
      hasAudio: z.boolean(),
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
  hasAudio: z.boolean(),
});

export const sourceSearchResponseSchema = z.object({
  languages: z.array(sourceSearchLanguageItemSchema),
  bibles: z.array(sourceSearchBibleItemSchema),
});

export type SourceSearchResponse = z.infer<typeof sourceSearchResponseSchema>;
export type SourceSearchLanguageItem = z.infer<typeof sourceSearchLanguageItemSchema>;
export type SourceSearchBibleItem = z.infer<typeof sourceSearchBibleItemSchema>;
