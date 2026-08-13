import { z } from '@hono/zod-openapi';

// ─── Path / query params ─────────────────────────────────────────────────────

export const projectIdParamSchema = z.object({
  projectId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'projectId', in: 'path' } }),
});

export const verseResourceParamSchema = projectIdParamSchema.extend({
  bookCode: z
    .string()
    .min(1)
    .openapi({ param: { name: 'bookCode', in: 'path' } }),
  chapter: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'chapter', in: 'path' } }),
  verse: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'verse', in: 'path' } }),
});

export const languageCodeQuerySchema = z.object({
  languageCode: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'languageCode', in: 'query' },
      description: 'Aquifer language code (e.g. eng)',
    }),
});

export const manifestQuerySchema = languageCodeQuerySchema.extend({
  bookCode: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'bookCode', in: 'query' },
      description: 'USFM book code (e.g. MRK)',
    }),
  startChapter: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'startChapter', in: 'query' } }),
  endChapter: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'endChapter', in: 'query' } }),
});

// ─── Online response items ───────────────────────────────────────────────────

export const tipTapContentSchema = z.unknown().openapi({
  description: 'Aquifer TipTap / content payload preserved as returned upstream',
});

export const translationNoteItemSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    localizedName: z.string(),
    content: tipTapContentSchema,
  })
  .openapi('TranslationNoteItem');

export const translationNotesResponseSchema = z
  .object({
    items: z.array(translationNoteItemSchema),
  })
  .openapi('TranslationNotesResponse');

export const translationQuestionItemSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    localizedName: z.string(),
    content: tipTapContentSchema,
  })
  .openapi('TranslationQuestionItem');

export const translationQuestionsResponseSchema = z
  .object({
    items: z.array(translationQuestionItemSchema),
  })
  .openapi('TranslationQuestionsResponse');

export const translationImageItemSchema = z
  .object({
    id: z.number().int(),
    title: z.string(),
    localizedName: z.string(),
    url: z.string(),
    thumbnailUrl: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .openapi('TranslationImageItem');

export const translationImagesResponseSchema = z
  .object({
    items: z.array(translationImageItemSchema),
  })
  .openapi('TranslationImagesResponse');

// ─── Prepare Offline manifest ────────────────────────────────────────────────

export const prepareOfflineResourceTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const prepareOfflineResourceKindSchema = z.enum(['text', 'audio', 'image']);

export const prepareOfflineManifestItemSchema = z
  .object({
    id: z.string(),
    tier: prepareOfflineResourceTierSchema,
    kind: prepareOfflineResourceKindSchema,
    resourceName: z.string(),
    label: z.string(),
    required: z.boolean(),
    removable: z.boolean(),
    bytesTotal: z.number().int().nonnegative(),
    sourceUrl: z.string().optional(),
    fileExt: z.string(),
    aquiferContentId: z.number().int().optional(),
    languageCode: z.string(),
    bookCode: z.string().optional(),
    startChapter: z.number().int().optional(),
    endChapter: z.number().int().optional(),
    collectionCode: z.string().optional(),
    resourceType: z.string().optional(),
    serializedContent: z.string().optional(),
  })
  .openapi('PrepareOfflineResourceManifestItem');

export const prepareOfflineManifestResponseSchema = z
  .object({
    projectId: z.number().int(),
    sourceLanguageCode: z.string(),
    items: z.array(prepareOfflineManifestItemSchema),
    totalBytes: z.number().int().nonnegative(),
  })
  .openapi('PrepareOfflineResourceManifest');

export type TranslationNotesResponse = z.infer<typeof translationNotesResponseSchema>;
export type TranslationQuestionsResponse = z.infer<typeof translationQuestionsResponseSchema>;
export type TranslationImagesResponse = z.infer<typeof translationImagesResponseSchema>;
export type PrepareOfflineManifestResponse = z.infer<typeof prepareOfflineManifestResponseSchema>;
export type PrepareOfflineManifestItem = z.infer<typeof prepareOfflineManifestItemSchema>;
