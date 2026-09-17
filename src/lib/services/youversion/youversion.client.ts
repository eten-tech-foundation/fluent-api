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

function youVersionError(code: ErrorCode, detail?: string): Extract<Result<never>, { ok: false }> {
  const base = ErrorMessages[code];
  return {
    ok: false,
    error: { code, message: detail ? `${base}: ${redactSecrets(detail)}` : base },
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
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Result<T>> {
  const target = query && query.toString() ? `${path}?${query.toString()}` : path;
  const fail = (detail: string) =>
    youVersionError(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE, `GET ${target} — ${detail}`);

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

  let rawBody: string;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-yvp-app-key': env.YOUVERSION_API_KEY!,
      },
      signal: controller.signal,
    });
    rawBody = await response.text();
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      return fail(`request timed out after ${timeoutMs}ms (elapsed ${elapsedMs}ms)`);
    }
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return fail(`YouVersion unreachable after ${elapsedMs}ms (${cause})`);
  } finally {
    clearTimeout(timeoutId);
  }

  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    return fail(
      `YouVersion returned HTTP ${response.status} ${response.statusText} in ${elapsedMs}ms; ` +
        `upstream body: ${bodySnippet(rawBody)}`
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
 * Returns the combined `data` array (strips pagination envelope).
 */
export async function getBibles(languageTag: string): Promise<Result<YouVersionBible[]>> {
  // YouVersion API requires raw `language_ranges[]` query key unencoded (without %5B%5D)
  const encodedTag = encodeURIComponent(languageTag);
  const basePathWithQuery = `/bibles?language_tag=${encodedTag}&language_ranges[]=${encodedTag}`;

  const allBibles: YouVersionBible[] = [];
  let pageToken: string | undefined;

  // Paginate until next_page_token is absent.
  while (true) {
    const pathWithQuery = pageToken
      ? `${basePathWithQuery}&page_token=${encodeURIComponent(pageToken)}`
      : basePathWithQuery;

    const result = await youVersionGet(pathWithQuery, youVersionBiblesResponseSchema);
    if (!result.ok) return result;

    allBibles.push(...result.data.data);

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
  passageId: string
): Promise<Result<YouVersionPassageResponse>> {
  return youVersionGet(
    `/bibles/${bibleId}/passages/${encodeURIComponent(passageId)}`,
    youVersionPassageResponseSchema
  );
}

/**
 * Fetch a single passage with bounded retry on HTTP 429.
 * Retries up to MAX_429_RETRIES times honouring the upstream Retry-After header.
 */
async function getPassageWithRetry(
  bibleId: number,
  passageId: string
): Promise<Result<YouVersionPassageResponse>> {
  let attempt = 0;
  while (true) {
    const result = await getPassage(bibleId, passageId);
    if (result.ok) return result;

    // Only retry on 429-like errors; detect by message convention from youVersionGet.
    const is429 = result.error.message.includes('HTTP 429');
    if (!is429 || attempt >= MAX_429_RETRIES) return result;

    attempt++;
    // Parse Retry-After from the error message if youVersionGet embedded it; fall back.
    const retryAfterMatch = /Retry-After:\s*(\d+)/i.exec(result.error.message);
    const delayMs = retryAfterMatch
      ? Math.min(Number(retryAfterMatch[1]) * 1_000, 60_000)
      : DEFAULT_RETRY_DELAY_MS * attempt;

    logger.warn({
      message: `YouVersion 429 on passage ${passageId}; retrying in ${delayMs}ms (attempt ${attempt}/${MAX_429_RETRIES})`,
      context: { bibleId, passageId, attempt, delayMs },
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
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
 *    requests, with bounded retry on 429 responses using Retry-After when available.
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

  // Step 2: concurrency-limited fan-out with 429 retry
  const tasks = verseMetas.map((vm) => () => getPassageWithRetry(bibleId, vm.passage_id));
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
    if (verseNumber <= 0) continue;

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
