import { z } from '@hono/zod-openapi';

import type {
  insertTranslatedVersesSchema,
  patchTranslatedVersesSchema,
  selectTranslatedVersesSchema,
} from '@/db/schema';

// Internal types
export type TranslatedVerseRecord = z.infer<typeof selectTranslatedVersesSchema> & {
  verseNumber: number;
};

export type CreateTranslatedVerseInput = z.infer<typeof insertTranslatedVersesSchema>;
export type UpdateTranslatedVerseInput = z.infer<typeof patchTranslatedVersesSchema>;

export interface TranslatedVersesFilters {
  projectUnitId?: number;
  bookId?: number;
  chapterNumber?: number;
}

// Explicit API response schemas
export const translatedVerseResponseSchema = z.object({
  id: z.number().int(),
  projectUnitId: z.number().int(),
  bibleTextId: z.number().int(),
  assignedUserId: z.number().int().nullable(),
  content: z.string(),
  verseNumber: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TranslatedVerseResponse = z.infer<typeof translatedVerseResponseSchema>;

// Const enumerations

export const TRANSLATED_VERSE_ACTIONS = {
  READ: 'read',
  EDIT: 'edit',
} as const;

export type TranslatedVerseAction =
  (typeof TRANSLATED_VERSE_ACTIONS)[keyof typeof TRANSLATED_VERSE_ACTIONS];

export const PROJECT_UNIT_ID_SOURCES = {
  VERSE_PARAM: 'verseParam',
  QUERY: 'query',
  BODY: 'body',
} as const;

export type ProjectUnitIdSource =
  (typeof PROJECT_UNIT_ID_SOURCES)[keyof typeof PROJECT_UNIT_ID_SOURCES];
