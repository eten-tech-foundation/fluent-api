import { z } from '@hono/zod-openapi';

export {
  aquiferAssociationResponseSchema,
  aquiferBibleSchema,
  aquiferBibleTextResponseSchema,
  aquiferLanguageResourceCountSchema,
  aquiferLanguageSchema,
  aquiferResourceCollectionSchema,
  aquiferResourceDetailsSchema,
  aquiferResourceSearchResponseSchema,
} from '@/lib/services/aquifer/aquifer.types';

export const availableResourcesQuerySchema = z.object({
  bookCode: z.string().openapi({ description: '3-letter book code, e.g. MRK', example: 'MRK' }),
  startChapter: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ description: 'Start chapter number', example: 1 }),
  endChapter: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ description: 'End chapter number', example: 1 }),
  startVerse: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ description: 'Start verse number', example: 1 }),
  endVerse: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ description: 'End verse number', example: 200 }),
});

export type AvailableResourcesQuery = z.infer<typeof availableResourcesQuerySchema>;

export const resourceCollectionCodeParamSchema = z.object({
  code: z.string().openapi({ description: 'Collection code', example: 'UWTranslationNotes' }),
});

export const searchResourcesQuerySchema = z.object({
  bookCode: z.string().openapi({ description: '3-letter book code', example: 'MRK' }),
  startChapter: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ description: 'Start chapter number', example: 1 }),
  endChapter: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ description: 'End chapter number', example: 1 }),
  languageCode: z.string().openapi({ description: 'ISO language code', example: 'eng' }),
  startVerse: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ description: 'Start verse number', example: 1 }),
  endVerse: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ description: 'End verse number', example: 200 }),
  resourceType: z
    .string()
    .optional()
    .openapi({ description: 'Resource type filter', example: 'Guide' }),
  resourceCollectionCode: z
    .string()
    .optional()
    .openapi({ description: 'Collection code filter', example: 'UWTranslationNotes' }),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ description: 'Item limit', example: 100 }),
  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .openapi({ description: 'Pagination offset', example: 0 }),
});

export type SearchResourcesQuery = z.infer<typeof searchResourcesQuerySchema>;

export const resourceContentIdParamSchema = z.object({
  contentId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ description: 'Aquifer content ID', example: 101 }),
});

export const parentResourceIdParamSchema = z.object({
  parentResourceId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ description: 'Parent resource ID', example: 101 }),
});

export const biblesQuerySchema = z.object({
  languageCode: z
    .string()
    .optional()
    .openapi({ description: 'ISO language code filter', example: 'eng' }),
});

export type BiblesQuery = z.infer<typeof biblesQuerySchema>;

export const bibleTextsParamSchema = z.object({
  bibleId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ description: 'Aquifer Bible ID', example: 1 }),
});

export const bibleTextsQuerySchema = z.object({
  bookCode: z.string().openapi({ description: '3-letter book code', example: 'MRK' }),
  startChapter: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ description: 'Start chapter number', example: 1 }),
  endChapter: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ description: 'End chapter number', example: 1 }),
  includeAudio: z
    .preprocess((val) => {
      if (typeof val === 'string') return val === 'true' || val === '1';
      return val;
    }, z.boolean())
    .optional()
    .openapi({ description: 'Whether to return audio data', example: true }),
});

export type BibleTextsQuery = z.infer<typeof bibleTextsQuerySchema>;
