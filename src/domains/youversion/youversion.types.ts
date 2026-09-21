import { z } from '@hono/zod-openapi';

export {
  youVersionBibleSchema,
  youVersionBibleVerseSchema,
  youVersionChapterTextSchema,
} from '@/lib/services/youversion/youversion.types';

// ─── Route-level query/param schemas ─────────────────────────────────────────

export const biblesQuerySchema = z.object({
  languageTag: z
    .string()
    .min(1)
    .openapi({ description: 'BCP-47 language tag (e.g. eng, fra)', example: 'eng' }),
});

export type BiblesQuery = z.infer<typeof biblesQuerySchema>;

export const chapterTextParamSchema = z.object({
  bibleId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ description: 'YouVersion Bible ID', example: 1 }),
  bookId: z
    .string()
    .min(1)
    .openapi({ description: 'Book code matching YouVersion book ID (e.g. GEN)', example: 'GEN' }),
  chapterId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ description: 'Chapter number', example: 1 }),
});

export type ChapterTextParam = z.infer<typeof chapterTextParamSchema>;
