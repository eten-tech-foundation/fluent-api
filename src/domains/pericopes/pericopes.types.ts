import { z } from '@hono/zod-openapi';

// ─── Pericope Set ─────────────────────────────────────────────────────────────

export const pericopeSetSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
}).openapi('PericopeSet');

export type PericopeSet = z.infer<typeof pericopeSetSchema>;

// ─── Chapter Pericopes Response ───────────────────────────────────────────────

export const pericopeVerseRefSchema = z.object({
  chapterNumber: z.number().int(),
  verseNumber: z.number().int(),
});

export const pericopeGroupSchema = z.object({
  pericopeNumber: z.string(),
  pericopeTitle: z.string().nullable(),
  verses: z.array(pericopeVerseRefSchema),
}).openapi('PericopeGroup');

export const chapterPericopesResponseSchema = z.array(pericopeGroupSchema)
  .openapi('ChapterPericopesResponse');

export type PericopeGroup = z.infer<typeof pericopeGroupSchema>;
export type ChapterPericopesResponse = z.infer<typeof chapterPericopesResponseSchema>;

// ─── Route params ─────────────────────────────────────────────────────────────

export const chapterPericopesParamSchema = z.object({
  id: z.coerce.number().int().positive().openapi({ param: { name: 'id', in: 'path' } }),
  bookCode: z.string().openapi({ param: { name: 'bookCode', in: 'path' } }),
  chapter: z.coerce.number().int().positive().openapi({ param: { name: 'chapter', in: 'path' } }),
});
