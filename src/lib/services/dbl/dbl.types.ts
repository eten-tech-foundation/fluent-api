import { z } from '@hono/zod-openapi';

/**
 * Shared types + response schemas for the DBL (Digital Bible Library)
 * integration, surfaced through the API.Bible REST API
 * (https://docs.api.bible/).
 *
 * Scope note: this file covers the read endpoints Fluent needs — Bibles,
 * Books, Chapters, Verses, Passages, and Audio Bibles. Sections and Search
 * are intentionally NOT modeled yet; add them in a follow-on ticket alongside
 * the service/business logic that consumes them.
 *
 * camelCase throughout — this mirrors API.Bible's wire contract verbatim (it
 * already responds in camelCase), so no field renaming happens at this layer.
 */

// ─── Content formatting options (shared by /chapters, /verses, /passages) ────

/**
 * `content-type` query param: controls how verse text is structured in the
 * response's `content` field. See https://docs.api.bible/guides/verses#verse-content
 *  - 'html': ready-to-render HTML (pairs with API.Bible's scripture-styles CSS)
 *  - 'json': structured content blocks, for callers building their own renderer
 *  - 'text': plain text only
 */
export const DblContentType = {
  HTML: 'html',
  JSON: 'json',
  TEXT: 'text',
} as const;

// eslint-disable-next-line ts/no-redeclare
export type DblContentType = (typeof DblContentType)[keyof typeof DblContentType];

/**
 * Query params accepted by the content-bearing endpoints (single chapter,
 * single verse, passage). All optional — omitted params fall back to
 * API.Bible's own defaults (see the per-method JSDoc for those).
 */
export interface DblContentQueryParams {
  contentType?: DblContentType;
  includeNotes?: boolean;
  includeTitles?: boolean;
  includeChapterNumbers?: boolean;
  includeVerseNumbers?: boolean;
  includeVerseSpans?: boolean;
  /** Bible IDs to return parallel verses from, alongside the primary result. */
  parallels?: string[];
  /** Look up the requested verse/passage by `orgId` instead of `id`. */
  useOrgId?: boolean;
}

// ─── Bibles ────────────────────────────────────────────────────────────────

const dblLanguageSchema = z.object({
  id: z.string(),
  name: z.string(),
  nameLocal: z.string(),
  script: z.string(),
  scriptDirection: z.string(),
});

const dblCountrySchema = z.object({
  id: z.string(),
  name: z.string(),
  nameLocal: z.string(),
});

const dblAudioBibleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  nameLocal: z.string(),
  description: z.string().nullish(),
  descriptionLocal: z.string().nullish(),
});

/**
 * Fields common to every Bible representation, list or single. Mirrors the
 * "Bible Data Structure" block in https://docs.api.bible/guides/bibles.
 */
const dblBibleBaseSchema = z.object({
  id: z.string(),
  dblId: z.string().nullish(),
  abbreviation: z.string(),
  abbreviationLocal: z.string(),
  language: dblLanguageSchema,
  countries: z.array(dblCountrySchema).nullish(),
  name: z.string(),
  nameLocal: z.string(),
  description: z.string().nullish(),
  descriptionLocal: z.string().nullish(),
  relatedDbl: z.string().nullish(),
  type: z.string().nullish(),
  updatedAt: z.string().nullish(),
  audioBibles: z.array(dblAudioBibleSummarySchema).nullish(),
});

/** `GET /bibles` list-item shape. */
export const dblBibleSummarySchema = dblBibleBaseSchema;
export type DblBibleSummary = z.infer<typeof dblBibleSummarySchema>;

/** `GET /bibles/{bibleId}` shape — adds fields only present on the single fetch. */
export const dblBibleSchema = dblBibleBaseSchema.extend({
  copyright: z.string().nullish(),
  info: z.string().nullish(),
});
export type DblBible = z.infer<typeof dblBibleSchema>;

export interface DblListBiblesParams {
  /** ISO 639-3 language code, e.g. 'eng'. */
  language?: string;
  abbreviation?: string;
  name?: string;
  /** Bible IDs to restrict the result set to. */
  ids?: string[];
  /** Returns copyright and promo info per Bible (same extra fields as the single-Bible fetch). */
  includeFullDetails?: boolean;
}

// ─── Books ─────────────────────────────────────────────────────────────────

const dblChapterSummarySchema = z.object({
  id: z.string(),
  bibleId: z.string().nullish(),
  number: z.string().nullish(),
  bookId: z.string().nullish(),
  reference: z.string().nullish(),
});
export type DblChapterSummary = z.infer<typeof dblChapterSummarySchema>;

export const dblBookSchema = z.object({
  id: z.string(),
  bibleId: z.string().nullish(),
  abbreviation: z.string().nullish(),
  name: z.string().nullish(),
  nameLong: z.string().nullish(),
  // Present only when `include-chapters` (or `include-chapters-and-sections`) is set.
  chapters: z.array(dblChapterSummarySchema).nullish(),
});
export type DblBook = z.infer<typeof dblBookSchema>;

export interface DblListBooksParams {
  includeChapters?: boolean;
  includeChaptersAndSections?: boolean;
}

export interface DblGetBookParams {
  includeChapters?: boolean;
}

// ─── Chapters ──────────────────────────────────────────────────────────────

const dblChapterNeighborSchema = z.object({
  id: z.string(),
  bookId: z.string().nullish(),
  number: z.coerce.string().nullish(),
});

/** `GET /bibles/{bibleId}/books/{bookId}/chapters` list-item shape (no content). */
export const dblChapterListItemSchema = dblChapterSummarySchema;
export type DblChapterListItem = z.infer<typeof dblChapterListItemSchema>;

/** `GET /bibles/{bibleId}/chapters/{chapterId}` shape — includes verse content. */
export const dblChapterSchema = z.object({
  id: z.string(),
  bibleId: z.string().nullish(),
  number: z.string().nullish(),
  bookId: z.string().nullish(),
  /** Shape depends on the `content-type` query param — see DblContentType. */
  content: z.unknown(),
  reference: z.string().nullish(),
  verseCount: z.number().nullish(),
  next: dblChapterNeighborSchema.nullish(),
  previous: dblChapterNeighborSchema.nullish(),
  copyright: z.string().nullish(),
});
export type DblChapter = z.infer<typeof dblChapterSchema>;

export const dblTimecodeSchema = z.object({
  start: z.string(),
  end: z.string(),
  verseId: z.string(),
});
export type DblTimecode = z.infer<typeof dblTimecodeSchema>;

/** `GET /audio-bibles/{audioBibleId}/chapters/{chapterId}` shape. */
export const dblAudioChapterSchema = z.object({
  id: z.string(),
  bibleId: z.string().nullish(),
  number: z.string().nullish(),
  bookId: z.string().nullish(),
  resourceUrl: z.string(),
  timecodes: z.array(dblTimecodeSchema).nullish(),
  expiresAt: z.coerce.number().nullish(),
  reference: z.string().nullish(),
  next: dblChapterNeighborSchema.nullish(),
  previous: dblChapterNeighborSchema.nullish(),
});
export type DblAudioChapter = z.infer<typeof dblAudioChapterSchema>;

// ─── Verses ────────────────────────────────────────────────────────────────

const dblVerseNeighborSchema = z.object({
  id: z.string(),
  bookId: z.string().nullish(),
});

/** `GET /bibles/{bibleId}/chapters/{chapterId}/verses` list-item shape (no content). */
export const dblVerseListItemSchema = z.object({
  id: z.string(),
  orgId: z.string().nullish(),
  bibleId: z.string().nullish(),
  bookId: z.string().nullish(),
  chapterId: z.string().nullish(),
  reference: z.string().nullish(),
});
export type DblVerseListItem = z.infer<typeof dblVerseListItemSchema>;

/** `GET /bibles/{bibleId}/verses/{verseId}` shape — includes content. */
export const dblVerseSchema = z.object({
  id: z.string(),
  orgId: z.string().nullish(),
  bibleId: z.string().nullish(),
  bookId: z.string().nullish(),
  chapterId: z.string().nullish(),
  /** Shape depends on the `content-type` query param — see DblContentType. */
  content: z.unknown(),
  reference: z.string().nullish(),
  verseCount: z.number().nullish(),
  copyright: z.string().nullish(),
  next: dblVerseNeighborSchema.nullish(),
  previous: dblVerseNeighborSchema.nullish(),
});
export type DblVerse = z.infer<typeof dblVerseSchema>;

// ─── Passages ──────────────────────────────────────────────────────────────

/**
 * `GET /bibles/{bibleId}/passages/{passageId}` shape. A Passage ID is two
 * Verse IDs joined by `-` (e.g. `GEN.1.1-GEN.2.3`) and may span chapters/books,
 * capped at 200 verses per API.Bible — see https://docs.api.bible/guides/passages.
 */
export const dblPassageSchema = z.object({
  id: z.string(),
  bibleId: z.string(),
  orgId: z.string().nullish(),
  /** Shape depends on the `content-type` query param — see DblContentType. */
  content: z.unknown(),
  reference: z.string(),
  verseCount: z.number().nullish(),
  copyright: z.string().nullish(),
});
export type DblPassage = z.infer<typeof dblPassageSchema>;
