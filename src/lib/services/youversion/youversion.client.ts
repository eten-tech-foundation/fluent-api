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
 * Returns only the `data` array (strips pagination envelope).
 */
export async function getBibles(languageTag: string): Promise<Result<YouVersionBible[]>> {
  // YouVersion API requires raw `language_ranges[]` query key unencoded (without %5B%5D)
  const encodedTag = encodeURIComponent(languageTag);
  const pathWithQuery = `/bibles?language_tag=${encodedTag}&language_ranges[]=${encodedTag}`;

  const result = await youVersionGet(pathWithQuery, youVersionBiblesResponseSchema);
  if (!result.ok) return result;
  return { ok: true, data: result.data.data };
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
 * Batch helper — fetch all verse texts for a chapter in one server call.
 *
 * 1. Calls getChapterMeta to get the ordered verse passage_id list.
 * 2. Fans out one getPassage per verse via Promise.allSettled (no partial failure aborts).
 * 3. Assembles the results into YouVersionChapterText, ordered by verse number.
 *
 * The per-verse fan-out stays server-side so the client sends exactly one request,
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

  // Step 2: fan out
  const passageResults = await Promise.allSettled(
    verseMetas.map((vm) => getPassage(bibleId, vm.passage_id))
  );

  // Step 3: assemble — skip verses that failed rather than failing the whole chapter
  const verses: YouVersionChapterText['verses'] = [];
  for (let i = 0; i < verseMetas.length; i++) {
    const meta = verseMetas[i];
    const settled = passageResults[i];

    if (settled.status === 'rejected') {
      logger.warn({
        message: 'YouVersion passage fetch rejected',
        context: { bibleId, passageId: meta.passage_id, reason: String(settled.reason) },
      });
      continue;
    }

    const passageResult = settled.value;
    if (!passageResult.ok) {
      logger.warn({
        message: 'YouVersion passage fetch failed',
        context: {
          bibleId,
          passageId: meta.passage_id,
          error: passageResult.error.message,
        },
      });
      continue;
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

  // Sort ascending — fan-out results can arrive out of order
  verses.sort((a, b) => a.verseNumber - b.verseNumber);

  return { ok: true, data: { bibleId, bookId, chapterId, verses } };
}
