import type { Result } from '@/lib/types';

import env from '@/env';
import { logger } from '@/lib/logger';
import { ErrorCode, ErrorMessages } from '@/lib/types';

import type {
  YouVersionBible,
  YouVersionChapterResponse,
  YouVersionChapterText,
  YouVersionPassageResponse,
} from './youversion.types';

import {
  youVersionBiblesResponseSchema,
  youVersionChapterResponseSchema,
  youVersionPassageResponseSchema,
} from './youversion.types';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Max concurrent upstream passage requests per chapter fetch. */
const PASSAGE_CONCURRENCY = 5;
/** Max retry attempts for HTTP 429 responses. */
const MAX_429_RETRIES = 3;
/** Fallback retry delay (ms) when no Retry-After header is present. */
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** Total wall-clock budget for a complete chapter fetch (meta + all passage fan-out). */
const CHAPTER_TOTAL_TIMEOUT_MS = 120_000;
/** Max pages consumed from the Bibles list endpoint to guard against infinite pagination. */
const MAX_BIBLES_PAGES = 20;
/** Cap on upstream body text echoed into logs. */
const MAX_LOGGED_BODY_CHARS = 300;
/** Cap on zod issues echoed into logs. */
const MAX_LOGGED_SCHEMA_ISSUES = 3;

/** Secret-bearing fields an upstream might echo back into an error body. */
const SECRET_FIELD_PATTERN =
  /("?(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|secret|password|authorization|x-yvp-app-key)"?\s*[:=]\s*)("?)([^"',}\s]+)\2/gi;

/**
 * Strip credentials from anything we echo out of an upstream response.
 */
function redactSecrets(text: string): string {
  let out = text.replace(SECRET_FIELD_PATTERN, '$1$2[redacted]$2');
  out = out.replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]');
  const key = env.YOUVERSION_API_KEY?.trim();
  if (key && key.length >= 8) {
    out = out.split(key).join('[redacted]');
  }
  return out;
}

/**
 * Structured error shape used internally by this module.
 * `httpStatus` and `retryAfterSeconds` are only present on non-2xx HTTP responses;
 * callers outside this file rely only on `code` and `message`.
 */
interface YouVersionHttpError {
  code: ErrorCode;
  message: string;
  /** HTTP status code returned by the upstream (absent for network/timeout errors). */
  httpStatus?: number;
  /** Parsed `Retry-After` header value in seconds (absent when the header is missing). */
  retryAfterSeconds?: number;
}

function youVersionError(
  code: ErrorCode,
  detail?: string,
  extra?: Pick<YouVersionHttpError, 'httpStatus' | 'retryAfterSeconds'>
): { ok: false; error: YouVersionHttpError } {
  const base = ErrorMessages[code];
  return {
    ok: false,
    error: {
      code,
      message: detail ? `${base}: ${redactSecrets(detail)}` : base,
      ...extra,
    },
  };
}

export function isYouVersionConfigured(): boolean {
  return Boolean(env.YOUVERSION_API_KEY?.trim());
}

function buildUrl(path: string, query?: URLSearchParams): string {
  const base = env.YOUVERSION_API_URL.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const qs = query && query.toString() ? `?${query.toString()}` : '';
  return `${base}${normalizedPath}${qs}`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function bodySnippet(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '<empty body>';
  return trimmed.length > MAX_LOGGED_BODY_CHARS
    ? `${trimmed.slice(0, MAX_LOGGED_BODY_CHARS)}…[truncated]`
    : trimmed;
}

function schemaIssueSummary(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> } | undefined)
    ?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return 'no issue detail';
  const shown = issues
    .slice(0, MAX_LOGGED_SCHEMA_ISSUES)
    .map((i) => `${(i.path ?? []).join('.') || '<root>'}: ${i.message ?? 'invalid'}`)
    .join('; ');
  const extra =
    issues.length > MAX_LOGGED_SCHEMA_ISSUES
      ? ` (+${issues.length - MAX_LOGGED_SCHEMA_ISSUES} more)`
      : '';
  return `${shown}${extra}`;
}

async function youVersionGet<T>(
  path: string,
  schema: {
    safeParse: (data: unknown) => { success: true; data: T } | { success: false; error?: unknown };
  },
  query?: URLSearchParams,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<{ ok: false; error: YouVersionHttpError } | { ok: true; data: T }> {
  const target = query && query.toString() ? `${path}?${query.toString()}` : path;
  const fail = (
    detail: string,
    extra?: Pick<YouVersionHttpError, 'httpStatus' | 'retryAfterSeconds'>
  ) =>
    youVersionError(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE, `GET ${target} — ${detail}`, extra);

  if (!isYouVersionConfigured()) {
    return fail('YOUVERSION_API_KEY is not configured');
  }

  try {
    if (new URL(env.YOUVERSION_API_URL).protocol !== 'https:') {
      return fail('YOUVERSION_API_URL must use HTTPS');
    }
  } catch {
    return fail('YOUVERSION_API_URL is not a valid URL');
  }

  const url = buildUrl(path, query);
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Combine the per-request timeout with any caller-supplied overall budget signal.
  const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  let rawBody: string;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-yvp-app-key': env.YOUVERSION_API_KEY!,
      },
      signal: fetchSignal,
    });
    rawBody = await response.text();
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      // Distinguish between the overall chapter budget firing vs. the per-request timeout.
      if (signal?.aborted) {
        return fail(`chapter budget exceeded (elapsed ${elapsedMs}ms)`);
      }
      return fail(`request timed out after ${timeoutMs}ms (elapsed ${elapsedMs}ms)`);
    }
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return fail(`YouVersion unreachable after ${elapsedMs}ms (${cause})`);
  } finally {
    clearTimeout(timeoutId);
  }

  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    // Read Retry-After as an integer seconds value; ignore if absent or non-numeric.
    const retryAfterRaw = response.headers.get('retry-after');
    const retryAfterSeconds =
      retryAfterRaw !== null && /^\d+$/.test(retryAfterRaw.trim())
        ? Number(retryAfterRaw.trim())
        : undefined;

    return fail(
      `YouVersion returned HTTP ${response.status} ${response.statusText} in ${elapsedMs}ms; ` +
        `upstream body: ${bodySnippet(rawBody)}`,
      { httpStatus: response.status, retryAfterSeconds }
    );
  }

  const parsed = rawBody.trim() ? safeJsonParse(rawBody) : {};
  if (parsed === undefined) {
    return fail(
      `HTTP ${response.status} but body was not valid JSON ` +
        `(content-type: ${response.headers.get('content-type') ?? 'none'}, ` +
        `${rawBody.length} chars): ${bodySnippet(rawBody)}`
    );
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return fail(
      `HTTP ${response.status} response payload failed schema validation ` +
        `(content-type: ${response.headers.get('content-type') ?? 'none'}, ` +
        `${rawBody.length} chars) — ${schemaIssueSummary(validated.error)}; ` +
        `body: ${bodySnippet(rawBody)}`
    );
  }

  return { ok: true, data: validated.data };
}

// ─── Public client functions ──────────────────────────────────────────────────

/**
 * Fetch YouVersion Bibles for a given language tag.
 * Follows `next_page_token` pagination until all pages are consumed.
 * Fails with YOUVERSION_SERVICE_UNAVAILABLE if pagination exceeds MAX_BIBLES_PAGES.
 * Returns the combined `data` array (strips pagination envelope).
 */
export async function getBibles(languageTag: string): Promise<Result<YouVersionBible[]>> {
  // YouVersion API requires raw `language_ranges[]` query key unencoded (without %5B%5D)
  const encodedTag = encodeURIComponent(languageTag);
  const basePathWithQuery = `/bibles?language_tag=${encodedTag}&language_ranges[]=${encodedTag}`;

  const allBibles: YouVersionBible[] = [];
  let pageToken: string | undefined;
  let page = 0;

  while (true) {
    if (page >= MAX_BIBLES_PAGES) {
      return youVersionError(
        ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE,
        `getBibles exceeded page cap (${MAX_BIBLES_PAGES}) for language "${languageTag}"`
      );
    }

    const pathWithQuery = pageToken
      ? `${basePathWithQuery}&page_token=${encodeURIComponent(pageToken)}`
      : basePathWithQuery;

    const result = await youVersionGet(pathWithQuery, youVersionBiblesResponseSchema);
    if (!result.ok) return result;

    allBibles.push(...result.data.data);
    page++;

    if (!result.data.next_page_token) break;
    pageToken = result.data.next_page_token;
  }

  return { ok: true, data: allBibles };
}

/**
 * Fetch chapter metadata (ordered verse list with passage_ids).
 * Used internally by getChapterText — not exposed as its own route.
 */
export async function getChapterMeta(
  bibleId: number,
  bookId: string,
  chapterId: number
): Promise<Result<YouVersionChapterResponse>> {
  return youVersionGet(
    `/bibles/${bibleId}/books/${encodeURIComponent(bookId)}/chapters/${chapterId}`,
    youVersionChapterResponseSchema
  );
}

/**
 * Fetch a single passage by its passage_id (e.g. "GEN.1.5").
 */
export async function getPassage(
  bibleId: number,
  passageId: string,
  signal?: AbortSignal
): Promise<Result<YouVersionPassageResponse, YouVersionHttpError>> {
  return youVersionGet(
    `/bibles/${bibleId}/passages/${encodeURIComponent(passageId)}`,
    youVersionPassageResponseSchema,
    undefined,
    DEFAULT_TIMEOUT_MS,
    signal
  );
}

/**
 * Fetch a single passage with bounded retry on HTTP 429.
 * Retries up to MAX_429_RETRIES times, honouring the upstream `Retry-After` header
 * when present and capping at 60 s; falls back to DEFAULT_RETRY_DELAY_MS * attempt.
 * Respects `signal` as a shared chapter-level budget — bails immediately if it fires.
 */
async function getPassageWithRetry(
  bibleId: number,
  passageId: string,
  signal?: AbortSignal
): Promise<Result<YouVersionPassageResponse, YouVersionHttpError>> {
  let attempt = 0;
  while (true) {
    // Bail immediately if the chapter budget has already been exhausted.
    if (signal?.aborted) {
      return youVersionError(
        ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE,
        `chapter budget exceeded before passage ${passageId}`
      );
    }

    const result = await getPassage(bibleId, passageId, signal);
    if (result.ok) return result;

    // Detect 429 via the structured httpStatus field — not string matching.
    const is429 = result.error.httpStatus === 429;
    if (!is429 || attempt >= MAX_429_RETRIES) return result;

    attempt++;
    // Use the Retry-After value plumbed through from the response header, if present.
    const delayMs =
      result.error.retryAfterSeconds !== undefined
        ? Math.min(result.error.retryAfterSeconds * 1_000, 60_000)
        : DEFAULT_RETRY_DELAY_MS * attempt;

    logger.warn({
      message: `YouVersion 429 on passage ${passageId}; retrying in ${delayMs}ms (attempt ${attempt}/${MAX_429_RETRIES})`,
      context: { bibleId, passageId, attempt, delayMs },
    });

    // Sleep for the retry delay, but exit early if the chapter budget fires.
    await new Promise<void>((resolve) => {
      const tid = setTimeout(resolve, delayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(tid);
          resolve();
        },
        { once: true }
      );
    });
  }
}

/**
 * Run an array of async tasks with a bounded concurrency limit.
 */
async function withConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = Array.from({ length: tasks.length });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Batch helper — fetch all verse texts for a chapter in one server call.
 *
 * 1. Calls getChapterMeta to get the ordered verse passage_id list.
 * 2. Fans out one getPassage per verse, bounded to PASSAGE_CONCURRENCY in-flight
 *    requests, with bounded retry on HTTP 429 responses (honouring Retry-After).
 *    A shared CHAPTER_TOTAL_TIMEOUT_MS budget aborts all in-flight fetches if the
 *    total operation runs too long, preventing unbounded hangs on large chapters.
 * 3. If any passage fails, the entire chapter request fails — no silent partial results.
 * 4. On success, assembles results into YouVersionChapterText ordered by verse number.
 *
 * The fan-out stays server-side so the client sends exactly one request,
 * and a single API key handles the full chapter load without leaking to the browser.
 */
export async function getChapterText(
  bibleId: number,
  bookId: string,
  chapterId: number
): Promise<Result<YouVersionChapterText>> {
  // Step 1: chapter meta
  const metaResult = await getChapterMeta(bibleId, bookId, chapterId);
  if (!metaResult.ok) return metaResult;

  const { verses: verseMetas } = metaResult.data;

  if (verseMetas.length === 0) {
    return {
      ok: true,
      data: { bibleId, bookId, chapterId, verses: [] },
    };
  }

  // Step 2: concurrency-limited fan-out with 429 retry, bounded by a total chapter budget.
  // AbortSignal.timeout() fires automatically — no manual cleanup needed.
  const chapterSignal = AbortSignal.timeout(CHAPTER_TOTAL_TIMEOUT_MS);
  const tasks = verseMetas.map(
    (vm) => () => getPassageWithRetry(bibleId, vm.passage_id, chapterSignal)
  );
  const passageResults = await withConcurrencyLimit(tasks, PASSAGE_CONCURRENCY);

  // Step 3: assemble — any failure causes the whole chapter to fail
  const verses: YouVersionChapterText['verses'] = [];
  for (let i = 0; i < verseMetas.length; i++) {
    const meta = verseMetas[i];
    const passageResult = passageResults[i];

    if (!passageResult.ok) {
      logger.warn({
        message: 'YouVersion passage fetch failed',
        context: {
          bibleId,
          passageId: meta.passage_id,
          error: passageResult.error.message,
        },
      });
      return youVersionError(
        ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE,
        `passage ${meta.passage_id} failed: ${passageResult.error.message}`
      );
    }

    // passage_id format: "GEN.1.5" — verse number is the third segment
    const verseNumber = Number.parseInt(meta.passage_id.split('.')[2] ?? '0', 10);
    if (!Number.isInteger(verseNumber) || verseNumber <= 0) continue;

    verses.push({
      verseNumber,
      passageId: meta.passage_id,
      content: passageResult.data.content,
    });
  }

  // Sort ascending — concurrency-limited results can arrive out of order
  verses.sort((a, b) => a.verseNumber - b.verseNumber);

  return { ok: true, data: { bibleId, bookId, chapterId, verses } };
}
