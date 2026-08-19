import { z } from '@hono/zod-openapi';

/** Canonical USFM book codes (same set as `src/db/seeds/data/books.json`). */
export const USFM_BOOK_CODES = [
  'GEN',
  'EXO',
  'LEV',
  'NUM',
  'DEU',
  'JOS',
  'JDG',
  'RUT',
  '1SA',
  '2SA',
  '1KI',
  '2KI',
  '1CH',
  '2CH',
  'EZR',
  'NEH',
  'EST',
  'JOB',
  'PSA',
  'PRO',
  'ECC',
  'SNG',
  'ISA',
  'JER',
  'LAM',
  'EZK',
  'DAN',
  'HOS',
  'JOL',
  'AMO',
  'OBA',
  'JON',
  'MIC',
  'NAM',
  'HAB',
  'ZEP',
  'HAG',
  'ZEC',
  'MAL',
  'MAT',
  'MRK',
  'LUK',
  'JHN',
  'ACT',
  'ROM',
  '1CO',
  '2CO',
  'GAL',
  'EPH',
  'PHP',
  'COL',
  '1TH',
  '2TH',
  '1TI',
  '2TI',
  'TIT',
  'PHM',
  'HEB',
  'JAS',
  '1PE',
  '2PE',
  '1JN',
  '2JN',
  '3JN',
  'JUD',
  'REV',
] as const;

export type UsfmBookCode = (typeof USFM_BOOK_CODES)[number];

const usfmBookCodeTuple = USFM_BOOK_CODES as unknown as [UsfmBookCode, ...UsfmBookCode[]];

export const usfmBookCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.enum(usfmBookCodeTuple));

/** Max chapters in one Prepare Offline manifest request (shared Aquifer key). */
export const MAX_MANIFEST_CHAPTER_SPAN = 20;

// ─── Path / query params ─────────────────────────────────────────────────────

export const projectIdParamSchema = z.object({
  projectId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'projectId', in: 'path' } }),
});

export const verseResourceParamSchema = projectIdParamSchema.extend({
  bookCode: usfmBookCodeSchema.openapi({ param: { name: 'bookCode', in: 'path' } }),
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
    .trim()
    .regex(/^[a-z]{2,3}$/i, 'languageCode must be a 2–3 letter ISO language code')
    .transform((value) => value.toLowerCase())
    .openapi({
      param: { name: 'languageCode', in: 'query' },
      description: 'Aquifer ISO language code (e.g. eng). Not the project source language.',
    }),
});

export const manifestQuerySchema = languageCodeQuerySchema
  .extend({
    bookCode: usfmBookCodeSchema.openapi({
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
    includeContent: z
      .enum(['true', 'false', '1', '0'])
      .optional()
      .transform((value) => value === 'true' || value === '1')
      .openapi({
        param: { name: 'includeContent', in: 'query' },
        description:
          'When true, include serializedContent (full TipTap JSON) on text items. Default omits bodies and returns bytesTotal only.',
      }),
  })
  .superRefine((value, ctx) => {
    if (value.endChapter < value.startChapter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endChapter'],
        message: 'endChapter must be greater than or equal to startChapter',
      });
    }
    const span = value.endChapter - value.startChapter + 1;
    if (span > MAX_MANIFEST_CHAPTER_SPAN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endChapter'],
        message: `Chapter range cannot exceed ${MAX_MANIFEST_CHAPTER_SPAN} chapters`,
      });
    }
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
    sourceLanguageCode: z.string().openapi({
      description:
        'Aquifer language the manifest was built for (the languageCode query param), not project.source_language',
    }),
    items: z.array(prepareOfflineManifestItemSchema),
    totalBytes: z.number().int().nonnegative(),
    truncated: z.boolean().openapi({
      description: 'True when one or more resource configs exceeded the per-config hydration cap',
    }),
  })
  .openapi('PrepareOfflineResourceManifest');

export type TranslationNotesResponse = z.infer<typeof translationNotesResponseSchema>;
export type TranslationQuestionsResponse = z.infer<typeof translationQuestionsResponseSchema>;
export type TranslationImagesResponse = z.infer<typeof translationImagesResponseSchema>;
export type PrepareOfflineManifestResponse = z.infer<typeof prepareOfflineManifestResponseSchema>;
export type PrepareOfflineManifestItem = z.infer<typeof prepareOfflineManifestItemSchema>;
