import { z } from '@hono/zod-openapi';

import { ttsLicenseStatusSchema } from '@/domains/bibles/bibles.types';
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
    sizeBytes: z.number().int().nonnegative().optional().openapi({
      description: 'Provider-reported file size; omitted when the provider does not supply it',
    }),
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
    endSeconds: z
      .number()
      .nonnegative()
      .optional()
      .openapi({
        description:
          'Offset at which this verse stops. Together with startSeconds this is the seek window ' +
          'into the chapter file: play from startSeconds, halt at endSeconds. Both providers ' +
          'publish an end for every verse they timestamp, the last verse of a chapter included, ' +
          'so a verse range has a known duration before any audio is fetched. Omitted when the ' +
          'provider gave no end for this verse.',
      }),
    dblAudioBibleId: z.string().optional().openapi({
      description:
        'DBL audio bible id for this timestamp when provider is dbl. Matches the item with the same id.',
    }),
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
    ttsLicenseStatus: ttsLicenseStatusSchema.optional().openapi({
      description: 'TTS licence status of the requested Fluent text Bible; not a user permission',
    }),
    licenseNotice: z.string().nullable().optional().openapi({
      description:
        'Curated notice for the requested Fluent Bible, not an inferred recording licence',
    }),
    bookCode: usfmBookCodeSchema,
    chapter: z.number().int().positive(),
    verse: z.number().int().positive().optional(),
    items: z.array(sourceAudioItemSchema),
    verseAddressable: z.boolean().openapi({
      description:
        'True when at least one recording has a start for every verse in the known chapter extent; ' +
        'this field, not the absence of verseTimestamps, signals verse-addressability.',
    }),
    verseTimestamps: z
      .array(sourceAudioVerseTimestampSchema)
      .optional()
      .openapi({
        description:
          'Per-verse seek windows into the chapter file (startSeconds..endSeconds). For DBL, each ' +
          'entry includes `dblAudioBibleId` matching the corresponding item. Absent entirely when ' +
          'the provider supplies no timing data for the chapter, which is the normal case for DBL.',
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
        'Fluent bible id (from chapter assignment). Resolves recordings by Aquifer pin, DBL link, then Aquifer abbreviation/name.',
    }),
  verse: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({
      param: { name: 'verse', in: 'query' },
      description:
        'Optional verse echoed in the response. All provider-supplied chapter timestamps and audio URLs are returned regardless.',
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
