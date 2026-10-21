import { z } from '@hono/zod-openapi';

// ─── Bible ────────────────────────────────────────────────────────────────────

/**
 * Internal — validates the raw YouVersion wire response.
 * Fields stay snake_case to match the upstream HTTP API exactly.
 * Never sent to clients; map to `youVersionBibleSchema` before responding.
 */
export const youVersionBibleWireSchema = z.object({
  id: z.number().int(),
  abbreviation: z.string(),
  localized_abbreviation: z.string(),
  title: z.string(),
  localized_title: z.string(),
  language_tag: z.string(),
  info: z.string().nullable().optional(),
  copyright: z.string().nullable().optional(),
  publisher_url: z.string().nullable().optional(),
  promotional_content: z.string().nullable().optional(),
  youversion_deep_link: z.string().nullable().optional(),
  organization_id: z.string().nullable().optional(),
  books: z.array(z.string()).nullable().optional(),
});

/**
 * Wire shape — only used inside `youversion.client.ts`.
 * @internal
 */
export type YouVersionBibleWire = z.infer<typeof youVersionBibleWireSchema>;

/**
 * Public shape returned by `GET /youversion/bibles`.
 * Normalized to camelCase following the Aquifer convention.
 */
export const youVersionBibleSchema = z
  .object({
    id: z.number().int(),
    abbreviation: z.string(),
    localizedAbbreviation: z.string(),
    title: z.string(),
    localizedTitle: z.string(),
    languageTag: z.string(),
    info: z.string().nullable().optional(),
    copyright: z.string().nullable().optional(),
    publisherUrl: z.string().nullable().optional(),
    promotionalContent: z.string().nullable().optional(),
    youversionDeepLink: z.string().nullable().optional(),
    organizationId: z.string().nullable().optional(),
    books: z.array(z.string()).nullable().optional(),
  })
  .openapi('YouVersionBible');

export type YouVersionBible = z.infer<typeof youVersionBibleSchema>;

/** Internal — wraps the paginated /bibles response. Never sent to clients. */
export const youVersionBiblesResponseSchema = z.object({
  data: z.array(youVersionBibleWireSchema),
  next_page_token: z.string().nullable().optional(),
  total_size: z.number().int().nullable().optional(),
});

// ─── Chapter metadata ─────────────────────────────────────────────────────────

export const youVersionVerseMetaSchema = z.object({
  id: z.union([z.string(), z.number()]),
  passage_id: z.string(),
  title: z.union([z.string(), z.number()]).nullable().optional(),
});

export type YouVersionVerseMeta = z.infer<typeof youVersionVerseMetaSchema>;

export const youVersionChapterResponseSchema = z.object({
  id: z.union([z.string(), z.number()]),
  passage_id: z.string(),
  title: z.union([z.string(), z.number()]).nullable().optional(),
  verses: z.array(youVersionVerseMetaSchema),
});

export type YouVersionChapterResponse = z.infer<typeof youVersionChapterResponseSchema>;

// ─── Passage ──────────────────────────────────────────────────────────────────

export const youVersionPassageResponseSchema = z.object({
  id: z.string(),
  content: z.string(),
  reference: z.string().nullable().optional(),
});

export type YouVersionPassageResponse = z.infer<typeof youVersionPassageResponseSchema>;

// ─── Batch chapter text (server-assembled, exposed to fluent-web) ─────────────

/**
 * One verse as returned by the batch chapter-text endpoint.
 * `passage_id` format: "GEN.1.5" — third segment is the verse number.
 */
export const youVersionBibleVerseSchema = z.object({
  verseNumber: z.number().int(),
  passageId: z.string(),
  content: z.string(),
});

export type YouVersionBibleVerse = z.infer<typeof youVersionBibleVerseSchema>;

/**
 * Response shape for `GET /youversion/bibles/{bibleId}/chapters/{chapterId}/text`.
 * The server fans out passage fetches internally so the client sends one request.
 */
export const youVersionChapterTextSchema = z
  .object({
    bibleId: z.number().int(),
    bookId: z.string(),
    chapterId: z.number().int(),
    verses: z.array(youVersionBibleVerseSchema),
  })
  .openapi('YouVersionChapterText');

export type YouVersionChapterText = z.infer<typeof youVersionChapterTextSchema>;
