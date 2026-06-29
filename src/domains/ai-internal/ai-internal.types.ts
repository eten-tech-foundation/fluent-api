import { z } from 'zod';

export const suggestionContextRequestSchema = z.object({
  projectUnitId: z.number().int().positive(),
  bibleId: z.number().int().positive(),
  bookCode: z.string().min(3).max(3),
  chapterNumber: z.number().int().positive(),
  verseStart: z.number().int().positive(),
  verseEnd: z.number().int().positive(),
});

export type SuggestionContextRequest = z.infer<typeof suggestionContextRequestSchema>;

export const aiSuggestionItemSchema = z.object({
  bibleTextId: z.number().int().positive(),
  projectUnitId: z.number().int().positive(),
  suggestedText: z.string(),
  modelInfo: z.string(),
});

export type AiSuggestionItem = z.infer<typeof aiSuggestionItemSchema>;

export const upsertAiSuggestionsRequestSchema = z.object({
  items: z.array(aiSuggestionItemSchema),
});

export type UpsertAiSuggestionsRequest = z.infer<typeof upsertAiSuggestionsRequestSchema>;

export interface ContextVerse {
  verse_id: string;
  source_text: string;
  target_text: string;
}

export interface SourceVerse {
  id: number;
  verse_number: number;
  text: string;
}

export interface SuggestionContextResponse {
  targetLanguageName: string;
  contextVerses: ContextVerse[];
  sourceVerses: SourceVerse[];
}
