import type { z } from '@hono/zod-openapi';

import type { Result } from '@/lib/types';

import env from '@/env';
import { logger } from '@/lib/logger';
import { ErrorCode, ErrorMessages } from '@/lib/types';

import type {
  DblAudioChapter,
  DblBible,
  DblBook,
  DblChapter,
  DblChapterListItem,
  DblContentQueryParams,
  DblGetBookParams,
  DblListBiblesParams,
  DblListBooksParams,
  DblPassage,
  DblVerse,
  DblVerseListItem,
} from './dbl.types';

import {
  dblAudioChapterSchema,
  dblBibleSchema,
  dblBibleSummarySchema,
  dblBookSchema,
  dblChapterListItemSchema,
  dblChapterSchema,
  dblPassageSchema,
  dblVerseListItemSchema,
  dblVerseSchema,
} from './dbl.types';

const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Config ────────────────────────────────────────────────────────────────

export interface DblClientConfig {
  /** e.g. https://rest.api.bible/v1 — no trailing slash. */
  baseUrl: string;
  /**
   * Personal/org API key from the api.bible dashboard, sent as the `api-key`
   * header (see https://docs.api.bible/quick-start/authentication).
   *
   * Required — enforced by env.ts validation (z.string().min(1)). The
   * DBL_NOT_CONFIGURED guard in dblRequest still exists as a safety net
   * for programmatic callers that construct their own config.
   */
  apiKey: string;
  /** Per-request timeout in ms, unless the caller supplies their own AbortSignal. */
  timeoutMs?: number;
}

/** Builds a DblClientConfig from validated app env (src/env.ts). */
export function dblConfigFromEnv(): DblClientConfig {
  return {
    baseUrl: env.DBL_API_BASE_URL,
    apiKey: env.DBL_API_KEY,
    timeoutMs: env.DBL_API_TIMEOUT_MS,
  };
}

// ─── Errors ────────────────────────────────────────────────────────────────

function dblError(code: ErrorCode, detail?: string): Extract<Result<never>, { ok: false }> {
  const base = ErrorMessages[code];
  return {
    ok: false,
    error: { code, message: detail ? `${base}: ${detail}` : base },
  };
}

// ─── URL / query-string helpers ───────────────────────────────────────────

type QueryValue = string | number | boolean | string[] | undefined;

/** Renders a params object into a query string, dropping unset values. Booleans stringify as 'true'/'false' and arrays join with commas, matching API.Bible's convention (e.g. `ids`, `parallels`). */
function toQueryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
      continue;
    }
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

function contentParamsToQuery(params?: DblContentQueryParams): Record<string, QueryValue> {
  if (!params) return {};
  return {
    'content-type': params.contentType,
    'include-notes': params.includeNotes,
    'include-titles': params.includeTitles,
    'include-chapter-numbers': params.includeChapterNumbers,
    'include-verse-numbers': params.includeVerseNumbers,
    'include-verse-spans': params.includeVerseSpans,
    parallels: params.parallels,
    'use-org-id': params.useOrgId,
  };
}

function buildUrl(baseUrl: string, path: string, query: Record<string, QueryValue> = {}): string {
  const base = baseUrl.replace(/\/+$/, '');
  const cleanPath = path.replace(/^\/+/, '');
  return `${base}/${cleanPath}${toQueryString(query)}`;
}

// ─── Core request ──────────────────────────────────────────────────────────

interface DblRequestOptions {
  /** Honored if the caller wants their own timeout / cancellation. */
  signal?: AbortSignal;
  /** Falls back to the client's configured timeoutMs, then DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Envelope every API.Bible read endpoint responds with: `{ data: T }`
 * (list endpoints respond `{ data: T[] }`). `meta` (FUMS tracking fields) is
 * accepted but not surfaced yet — see https://docs.api.bible/resources/fair-use;
 * a follow-on ticket wires FUMS reporting once there's a UI to fire it from.
 */
async function dblRequest<T>(
  config: DblClientConfig,
  path: string,
  query: Record<string, QueryValue>,
  dataSchema: z.ZodType<T>,
  options?: DblRequestOptions
): Promise<Result<T>> {
  if (!config.apiKey) {
    return dblError(
      ErrorCode.DBL_NOT_CONFIGURED,
      'DBL_API_KEY is not set — the API.Bible key request is still pending (see parent discovery ticket)'
    );
  }

  const url = buildUrl(config.baseUrl, path, query);
  const timeoutMs = options?.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let signal: AbortSignal;
  if (options?.signal) {
    signal = options.signal;
  } else {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    signal = controller.signal;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'api-key': config.apiKey },
      signal,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      return dblError(ErrorCode.DBL_SERVICE_UNAVAILABLE, `request timed out after ${timeoutMs}ms`);
    }
    const cause = error instanceof Error ? error.message : String(error);
    return dblError(ErrorCode.DBL_SERVICE_UNAVAILABLE, `DBL API unreachable (${cause})`);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  const rawBody = await response.text();

  if (!response.ok) {
    return dblError(ErrorCode.DBL_SERVICE_UNAVAILABLE, `DBL API returned HTTP ${response.status}`);
  }

  const parsed = safeJsonParse(rawBody);
  if (parsed === undefined) {
    return dblError(
      ErrorCode.DBL_SERVICE_UNAVAILABLE,
      'malformed response from DBL API (body was not valid JSON)'
    );
  }

  if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) {
    return dblError(
      ErrorCode.DBL_SERVICE_UNAVAILABLE,
      'malformed response from DBL API (missing data envelope)'
    );
  }

  const envelope = parsed as { data: unknown };
  const dataResult = dataSchema.safeParse(envelope.data);
  if (!dataResult.success) {
    logger.error(
      `DBL API response failed schema validation for path [${path}]: ${JSON.stringify(dataResult.error.issues)}`,
      {
        path,
        zodErrors: dataResult.error.issues,
      }
    );
    return dblError(ErrorCode.DBL_SERVICE_UNAVAILABLE, 'malformed response payload from DBL API');
  }

  return { ok: true, data: dataResult.data };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ─── Client interface ──────────────────────────────────────────────────────

/**
 * Minimal, typed surface over the DBL/API.Bible read endpoints Fluent needs.
 * Business logic (mapping to Fluent's data models, persistence, licensing
 * checks, etc.) is explicitly out of scope here — see follow-on tickets.
 */
export interface DblClient {
  /** GET /bibles — every Bible the configured key has access to. */
  getBibles: (
    params?: DblListBiblesParams,
    options?: DblRequestOptions
  ) => Promise<Result<DblBible[]>>;
  /** GET /bibles/{bibleId} */
  getBible: (bibleId: string, options?: DblRequestOptions) => Promise<Result<DblBible>>;
  /** GET /bibles/{bibleId}/books */
  getBooks: (
    bibleId: string,
    params?: DblListBooksParams,
    options?: DblRequestOptions
  ) => Promise<Result<DblBook[]>>;
  /** GET /bibles/{bibleId}/books/{bookId} */
  getBook: (
    bibleId: string,
    bookId: string,
    params?: DblGetBookParams,
    options?: DblRequestOptions
  ) => Promise<Result<DblBook>>;
  /** GET /bibles/{bibleId}/books/{bookId}/chapters — no verse content; see getChapter. */
  getChapters: (
    bibleId: string,
    bookId: string,
    options?: DblRequestOptions
  ) => Promise<Result<DblChapterListItem[]>>;
  /** GET /bibles/{bibleId}/chapters/{chapterId} — includes verse content. */
  getChapter: (
    bibleId: string,
    chapterId: string,
    params?: DblContentQueryParams,
    options?: DblRequestOptions
  ) => Promise<Result<DblChapter>>;
  /** GET /bibles/{bibleId}/chapters/{chapterId}/verses — no content; see getVerse. */
  getVerses: (
    bibleId: string,
    chapterId: string,
    options?: DblRequestOptions
  ) => Promise<Result<DblVerseListItem[]>>;
  /** GET /bibles/{bibleId}/verses/{verseId} — includes content. */
  getVerse: (
    bibleId: string,
    verseId: string,
    params?: DblContentQueryParams,
    options?: DblRequestOptions
  ) => Promise<Result<DblVerse>>;
  /**
   * GET /bibles/{bibleId}/passages/{passageId} — arbitrary verse range,
   * `passageId` is two Verse IDs joined by `-` (e.g. `GEN.1.1-GEN.2.3`),
   * capped at 200 verses by the API.
   */
  getPassage: (
    bibleId: string,
    passageId: string,
    params?: DblContentQueryParams,
    options?: DblRequestOptions
  ) => Promise<Result<DblPassage>>;
  /** GET /audio-bibles/{audioBibleId}/chapters/{chapterId} */
  getAudioChapter: (
    audioBibleId: string,
    chapterId: string,
    options?: DblRequestOptions
  ) => Promise<Result<DblAudioChapter>>;
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Builds a DblClient bound to the given config. Pure factory (no module-level
 * state), so tests can construct one with a fake apiKey/baseUrl, and future
 * multi-tenant setups can construct more than one if ever needed.
 */
export function createDblClient(config: DblClientConfig): DblClient {
  return {
    getBibles(params, options) {
      return dblRequest(
        config,
        'bibles',
        {
          language: params?.language,
          abbreviation: params?.abbreviation,
          name: params?.name,
          ids: params?.ids,
          'include-full-details': params?.includeFullDetails,
        },
        dblBibleSummarySchema.array(),
        options
      );
    },

    getBible(bibleId, options) {
      return dblRequest(
        config,
        `bibles/${encodeURIComponent(bibleId)}`,
        {},
        dblBibleSchema,
        options
      );
    },

    getBooks(bibleId, params, options) {
      return dblRequest(
        config,
        `bibles/${encodeURIComponent(bibleId)}/books`,
        {
          'include-chapters': params?.includeChapters,
          'include-chapters-and-sections': params?.includeChaptersAndSections,
        },
        dblBookSchema.array(),
        options
      );
    },

    getBook(bibleId, bookId, params, options) {
      return dblRequest(
        config,
        `bibles/${encodeURIComponent(bibleId)}/books/${encodeURIComponent(bookId)}`,
        { 'include-chapters': params?.includeChapters },
        dblBookSchema,
        options
      );
    },

    getChapters(bibleId, bookId, options) {
      return dblRequest(
        config,
        `bibles/${encodeURIComponent(bibleId)}/books/${encodeURIComponent(bookId)}/chapters`,
        {},
        dblChapterListItemSchema.array(),
        options
      );
    },

    getChapter(bibleId, chapterId, params, options) {
      return dblRequest(
        config,
        `bibles/${encodeURIComponent(bibleId)}/chapters/${encodeURIComponent(chapterId)}`,
        contentParamsToQuery(params),
        dblChapterSchema,
        options
      );
    },

    getVerses(bibleId, chapterId, options) {
      return dblRequest(
        config,
        `bibles/${encodeURIComponent(bibleId)}/chapters/${encodeURIComponent(chapterId)}/verses`,
        {},
        dblVerseListItemSchema.array(),
        options
      );
    },

    getVerse(bibleId, verseId, params, options) {
      return dblRequest(
        config,
        `bibles/${encodeURIComponent(bibleId)}/verses/${encodeURIComponent(verseId)}`,
        contentParamsToQuery(params),
        dblVerseSchema,
        options
      );
    },

    getPassage(bibleId, passageId, params, options) {
      return dblRequest(
        config,
        `bibles/${encodeURIComponent(bibleId)}/passages/${encodeURIComponent(passageId)}`,
        contentParamsToQuery(params),
        dblPassageSchema,
        options
      );
    },

    getAudioChapter(audioBibleId, chapterId, options) {
      return dblRequest(
        config,
        `audio-bibles/${encodeURIComponent(audioBibleId)}/chapters/${encodeURIComponent(chapterId)}`,
        {},
        dblAudioChapterSchema,
        options
      );
    },
  };
}

/**
 * App-wide DBL client, instantiated from validated env config at module load.
 * Other Fluent services import this directly (mirrors the fluent-ai client
 * convention — see src/lib/services/fluent-ai/fluent-ai.client.ts) rather than
 * receiving it through a DI container.
 *
 * Safe to import even when DBL_API_KEY is unset: every method returns
 * Result.err(DBL_NOT_CONFIGURED) instead of throwing or failing app boot.
 */
export const dblClient: DblClient = createDblClient(dblConfigFromEnv());
