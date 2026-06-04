import { z } from '@hono/zod-openapi';

export const bibleTextResponseSchema = z.object({
  id: z.number().int(),
  chapterNumber: z.number().int(),
  verseNumber: z.number().int(),
  text: z.string(),
});

export type BibleTextResponse = z.infer<typeof bibleTextResponseSchema>;

// ─── Bulk fetch ───────────────────────────────────────────────────────────────

export const bulkChapterRequestSchema = z.object({
  chapters: z
    .array(
      z.object({
        bookId: z.number().int().positive(),
        chapterNumber: z.number().int().positive(),
      })
    )
    .min(1, 'At least one chapter is required')
    .max(1200, 'Maximum 1200 chapters per request'),
  updatedAfter: z.string().datetime().optional(),
});

export const bulkChapterTextResponseSchema = z.object({
  bookId: z.number().int(),
  chapterNumber: z.number().int(),
  verses: bibleTextResponseSchema.array(),
});

export const bulkBibleTextsResponseSchema = z.object({
  syncedAt: z.string(),
  data: bulkChapterTextResponseSchema.array(),
});

export type BulkBibleTextsResponse = z.infer<typeof bulkBibleTextsResponseSchema>;
export type BulkChapterRequest = z.infer<typeof bulkChapterRequestSchema>;
export type BulkChapterTextResponse = z.infer<typeof bulkChapterTextResponseSchema>;

export type BulkBibleTextsRequest = z.infer<typeof bulkChapterRequestSchema>;

export interface BulkVerseRow {
  id: number;
  bookId: number;
  chapterNumber: number;
  verseNumber: number;
  text: string;
}
