import { z } from '@hono/zod-openapi';

import type { selectBibleBooksSchema } from '@/db/schema';

export type BibleBook = z.infer<typeof selectBibleBooksSchema>;

export const createBibleBookSchema = z.object({
  bibleId: z.number().int().positive(),
  bookId: z.number().int().positive(),
});

export const bibleBookResponseSchema = z.object({
  bibleId: z.number().int(),
  bookId: z.number().int(),
  hasAudio: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const bibleBookDetailResponseSchema = z.object({
  bibleId: z.number().int(),
  bookId: z.number().int(),
  hasAudio: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  book: z.object({
    id: z.number().int(),
    code: z.string(),
    eng_display_name: z.string(),
  }),
  bible: z.object({
    id: z.number().int(),
    name: z.string(),
  }),
});

export type CreateBibleBookInput = z.infer<typeof createBibleBookSchema>;

export interface BibleBookWithDetails extends BibleBook {
  book: {
    id: number;
    code: string;
    eng_display_name: string;
  };
  bible: {
    id: number;
    name: string;
  };
}

export type BibleBookResponse = z.infer<typeof bibleBookResponseSchema>;
export type BibleBookDetailResponse = z.infer<typeof bibleBookDetailResponseSchema>;
