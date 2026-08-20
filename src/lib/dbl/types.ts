import { z } from 'zod';

// ─── API.Bible Response Schemas ────────────────────────────────────────────
//
// Strict Zod schemas for every entity returned by the DBL / API.Bible REST API.
// These are used by `DblClient.fetchWithRetry()` to parse and validate raw JSON
// responses at runtime. If API.Bible silently changes its contract, these schemas
// will throw a ZodError immediately rather than allowing malformed data into the
// database.
//
// Reference: https://docs.api.bible/reference

/** Language metadata attached to each Bible entry in the catalogue. */
export const DblLanguageSchema = z.object({
  id: z.string(),
  name: z.string(),
  nameLocal: z.string(),
  script: z.string(),
  scriptDirection: z.enum(['LTR', 'RTL']),
});

/**
 * A single Bible in the API.Bible catalogue.
 *
 * Notes:
 * - `dblId` may be absent for non-DBL Bibles in the catalogue, so it's optional.
 * - `abbreviationLocal` is optional; when present we prefer it over `abbreviation`.
 * - `info` may contain licensing hints ("restricted", "commercial") used by our
 *   open-license filter in `ingestDblBibles()`.
 * - `audioBibles` is typed here for future Audio Bible support but not yet consumed.
 */
export const DblBibleSchema = z.object({
  id: z.string(),
  dblId: z.string().optional(),
  abbreviation: z.string(),
  abbreviationLocal: z.string().optional(),
  language: DblLanguageSchema,
  countries: z
    .array(z.object({ id: z.string(), name: z.string(), nameLocal: z.string() }))
    .optional(),
  name: z.string(),
  nameLocal: z.string(),
  description: z.string().nullable().optional(),
  descriptionLocal: z.string().nullable().optional(),
  info: z.string().nullable().optional(),
  type: z.string(),
  updatedAt: z.string(),
  audioBibles: z
    .array(z.object({ id: z.string(), name: z.string(), nameLocal: z.string() }))
    .optional(),
});
export type DblBible = z.infer<typeof DblBibleSchema>;

/** A single book within a Bible (e.g. Genesis, Exodus). */
export const DblBookSchema = z.object({
  id: z.string(),
  bibleId: z.string(),
  abbreviation: z.string(),
  name: z.string(),
  nameLong: z.string(),
});
export type DblBook = z.infer<typeof DblBookSchema>;

/** A single chapter within a book. The `number` field is a string (e.g. "1", "intro"). */
export const DblChapterSchema = z.object({
  id: z.string(),
  bibleId: z.string(),
  bookId: z.string(),
  number: z.string(),
  reference: z.string(),
});
export type DblChapter = z.infer<typeof DblChapterSchema>;

/**
 * A single verse within a chapter.
 *
 * Notes:
 * - `orgId` is not always present on verse summary objects, so it's optional.
 * - `text` is optional because some API responses only include verse metadata
 *   without the actual text content.
 */
export const DblVerseSchema = z.object({
  id: z.string(),
  orgId: z.string().optional(),
  bibleId: z.string(),
  bookId: z.string(),
  chapterId: z.string(),
  reference: z.string(),
  text: z.string().optional(),
});
export type DblVerse = z.infer<typeof DblVerseSchema>;

/**
 * Creates a wrapper schema for API.Bible's standard response envelope.
 * All API.Bible endpoints return `{ data: T, meta?: ... }`.
 */
export function createDblResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    meta: z.any().optional(),
  });
}
