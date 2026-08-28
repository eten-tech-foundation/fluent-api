import { z } from '@hono/zod-openapi';

import {
  languageCodeQuerySchema,
  MAX_MANIFEST_CHAPTER_SPAN,
  projectIdParamSchema,
  usfmBookCodeSchema,
} from '@/domains/translation-resources/translation-resources.types';

export const SOURCE_AUDIO_PROVIDERS = ['dbl', 'aquifer'] as const;

export type SourceAudioProvider = (typeof SOURCE_AUDIO_PROVIDERS)[number];

export const sourceAudioFormatSchema = z.enum(['mp3', 'webm']);

export const sourceAudioScopeSchema = z.enum(['chapter', 'verse']);

export const sourceAudioItemSchema = z
  .object({
    format: sourceAudioFormatSchema,
    url: z.string().url(),
    sizeBytes: z.number().int().nonnegative(),
    scope: sourceAudioScopeSchema,
    durationSeconds: z.number().nonnegative().optional(),
    expiresAt: z.number().optional(),
    dblAudioBibleId: z.string().optional().openapi({
      description: 'DBL audio bible id for this item when provider is dbl',
    }),
  })
  .openapi('SourceAudioItem');

export const sourceAudioVerseTimestampSchema = z
  .object({
    verse: z.number().int().positive(),
    startSeconds: z.number().nonnegative().optional(),
  })
  .openapi('SourceAudioVerseTimestamp');

export const sourceAudioBibleSchema = z
  .object({
    aquiferBibleId: z.number().int().optional(),
    dblAudioBibleId: z.string().optional(),
    name: z.string(),
    abbreviation: z.string(),
    fluentBibleId: z.number().int().optional(),
  })
  .openapi('SourceAudioBible');

export const sourceAudioResponseSchema = z
  .object({
    provider: z.enum(SOURCE_AUDIO_PROVIDERS),
    bible: sourceAudioBibleSchema,
    bookCode: usfmBookCodeSchema,
    chapter: z.number().int().positive(),
    verse: z.number().int().positive().optional(),
    items: z.array(sourceAudioItemSchema),
    verseTimestamps: z.array(sourceAudioVerseTimestampSchema).optional().openapi({
      description:
        'Verse start offsets for the primary DBL audio bible (`bible.dblAudioBibleId`). Additional DBL items may have different timings.',
    }),
  })
  .openapi('SourceAudioResponse');

export const chapterSourceAudioParamSchema = projectIdParamSchema.extend({
  bookCode: usfmBookCodeSchema.openapi({ param: { name: 'bookCode', in: 'path' } }),
  chapter: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'chapter', in: 'path' } }),
});

export const sourceAudioQuerySchema = languageCodeQuerySchema.extend({
  bibleId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'bibleId', in: 'query' },
      description:
        'Fluent bible id (from chapter assignment). Used to match the Aquifer Bible by abbreviation/name.',
    }),
  verse: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({
      param: { name: 'verse', in: 'query' },
      description:
        'Optional verse for verse-level timestamps. Chapter audio URLs are returned regardless.',
    }),
});

export const sourceAudioManifestQuerySchema = languageCodeQuerySchema
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
    bibleId: z.coerce
      .number()
      .int()
      .positive()
      .openapi({
        param: { name: 'bibleId', in: 'query' },
        description: 'Fluent bible id used to resolve the Aquifer Bible.',
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

export const sourceAudioManifestItemSchema = z
  .object({
    id: z.string(),
    tier: z.literal(1),
    kind: z.literal('audio'),
    resourceName: z.literal('Source Bible Audio'),
    label: z.string(),
    required: z.boolean(),
    removable: z.boolean(),
    bytesTotal: z.number().int().nonnegative(),
    sourceUrl: z.string().url(),
    fileExt: z.string(),
    languageCode: z.string(),
    bookCode: usfmBookCodeSchema,
    startChapter: z.number().int().positive(),
    endChapter: z.number().int().positive(),
    format: sourceAudioFormatSchema,
    aquiferBibleId: z.number().int(),
  })
  .openapi('SourceAudioManifestItem');

export const sourceAudioManifestResponseSchema = z
  .object({
    projectId: z.number().int(),
    sourceLanguageCode: z.string(),
    provider: z.enum(SOURCE_AUDIO_PROVIDERS),
    items: z.array(sourceAudioManifestItemSchema),
    totalBytes: z.number().int().nonnegative(),
  })
  .openapi('SourceAudioManifestResponse');

export type SourceAudioResponse = z.infer<typeof sourceAudioResponseSchema>;
export type SourceAudioManifestResponse = z.infer<typeof sourceAudioManifestResponseSchema>;
export type SourceAudioItem = z.infer<typeof sourceAudioItemSchema>;
