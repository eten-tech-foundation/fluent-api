import { z } from '@hono/zod-openapi';

// ─── Pericope Set ─────────────────────────────────────────────────────────────

export const pericopeSetSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    description: z.string().nullable(),
  })
  .openapi('PericopeSet');

export type PericopeSet = z.infer<typeof pericopeSetSchema>;

// ─── Chapter Pericopes Response ───────────────────────────────────────────────

export const pericopeVerseRefSchema = z.object({
  chapterNumber: z.number().int(),
  verseNumber: z.number().int(),
});

export const pericopeGroupSchema = z
  .object({
    pericopeNumber: z.string(),
    pericopeTitle: z.string().nullable(),
    verses: z.array(pericopeVerseRefSchema),
  })
  .openapi('PericopeGroup');

export const chapterPericopesResponseSchema = z
  .array(pericopeGroupSchema)
  .openapi('ChapterPericopesResponse');

export type PericopeGroup = z.infer<typeof pericopeGroupSchema>;
export type ChapterPericopesResponse = z.infer<typeof chapterPericopesResponseSchema>;

export const pericopeSetGroupSchema = pericopeGroupSchema
  .extend({ bookCode: z.string() })
  .openapi('PericopeSetGroup');

export const pericopeSetResponseSchema = z
  .array(pericopeSetGroupSchema)
  .openapi('PericopeSetResponse');

export type PericopeSetResponse = z.infer<typeof pericopeSetResponseSchema>;

export interface PericopeVerseRow {
  chapterNumber: number;
  verseNumber: number;
  section: number | null;
  pericopeNumber: string;
  pericopeTitle: string | null;
}

export const pericopeSetParamSchema = z.object({
  id: z.coerce
    .number()
    .int()
    .positive()
    .max(2147483647)
    .openapi({ param: { name: 'id', in: 'path' } }),
});

export const pericopeSetQuerySchema = z.object({
  bookCode: z
    .string()
    .trim()
    .toUpperCase()
    // eslint-disable-next-line regexp/use-ignore-case -- OpenAPI exports the pattern without regex flags.
    .regex(/^[A-Za-z0-9]{3}$/)
    .optional()
    .openapi({
      description: 'Optional three-character book code, normalized to uppercase.',
      example: 'MRK',
    }),
});

// ─── Route params ─────────────────────────────────────────────────────────────

export const chapterPericopesParamSchema = z.object({
  id: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'id', in: 'path' } }),
  bookCode: z.string().openapi({ param: { name: 'bookCode', in: 'path' } }),
  chapter: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'chapter', in: 'path' } }),
});
