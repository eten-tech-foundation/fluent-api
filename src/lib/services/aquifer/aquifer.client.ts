import type { Result } from '@/lib/types';

import env from '@/env';
import { ErrorCode, ErrorMessages } from '@/lib/types';

import type {
  AquiferResourceDetails,
  AquiferResourceSearchResponse,
  AquiferSearchResourcesParams,
} from './aquifer.types';

import { aquiferResourceDetailsSchema, aquiferResourceSearchResponseSchema } from './aquifer.types';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Hard cap on search pagination to avoid unbounded Aquifer fan-out. */
const MAX_SEARCH_PAGES = 20;
/** Cap on upstream body text echoed into logs. */
const MAX_LOGGED_BODY_CHARS = 300;
/** Cap on zod issues echoed into logs. */
const MAX_LOGGED_SCHEMA_ISSUES = 3;

function aquiferError(code: ErrorCode, detail?: string): Extract<Result<never>, { ok: false }> {
  const base = ErrorMessages[code];
  return {
    ok: false,
    error: { code, message: detail ? `${base}: ${detail}` : base },
  };
}

export function isAquiferConfigured(): boolean {
  return Boolean(env.AQUIFER_API_KEY?.trim());
}

function buildUrl(path: string, query?: URLSearchParams): string {
  const base = env.AQUIFER_API_URL.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const qs = query && query.toString() ? `?${query.toString()}` : '';
  return `${base}${normalizedPath}${qs}`;
}

function appendParams(
  params: URLSearchParams,
  entries: Record<string, string | number | undefined>
): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== '') {
      params.append(key, String(value));
    }
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Upstream bodies carry the real reason ("Invalid API key", serializer errors). */
function bodySnippet(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '<empty body>';
  return trimmed.length > MAX_LOGGED_BODY_CHARS
    ? `${trimmed.slice(0, MAX_LOGGED_BODY_CHARS)}…[truncated]`
    : trimmed;
}

/** First few zod issues, so schema drift names the offending field. */
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

async function aquiferGet<T>(
  path: string,
  schema: {
    safeParse: (data: unknown) => { success: true; data: T } | { success: false; error?: unknown };
  },
  query?: URLSearchParams,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Result<T>> {
  const target = query && query.toString() ? `${path}?${query.toString()}` : path;
  const fail = (detail: string) =>
    aquiferError(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE, `GET ${target} — ${detail}`);

  if (!isAquiferConfigured()) {
    return fail('AQUIFER_API_KEY is not configured');
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
      // No Content-Type: these are bodyless GETs, and declaring application/json
      // makes Aquifer's deserializer reject the empty body with HTTP 400.
      headers: {
        'api-key': env.AQUIFER_API_KEY!,
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
    return fail(`Aquifer unreachable after ${elapsedMs}ms (${cause})`);
  } finally {
    clearTimeout(timeoutId);
  }

  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    return fail(
      `Aquifer returned HTTP ${response.status} ${response.statusText} in ${elapsedMs}ms; ` +
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
      `response payload failed schema validation — ${schemaIssueSummary(validated.error)}; ` +
        `body: ${bodySnippet(rawBody)}`
    );
  }

  return { ok: true, data: validated.data };
}

/**
 * Search Aquifer resources by scripture range + language + collection/type.
 * Mirrors fluent-mobile / fluent-web Aquifer clients (BookCode, StartChapter, …).
 */
export async function searchResources(
  params: AquiferSearchResourcesParams
): Promise<Result<AquiferResourceSearchResponse>> {
  const query = new URLSearchParams();
  appendParams(query, {
    BookCode: params.bookCode,
    StartChapter: params.startChapter,
    EndChapter: params.endChapter,
    LanguageCode: params.languageCode,
    StartVerse: params.startVerse,
    EndVerse: params.endVerse,
    ResourceType: params.resourceType,
    ResourceCollectionCode: params.resourceCollectionCode,
    Limit: params.limit ?? 100,
    Offset: params.offset,
  });

  return aquiferGet('/resources/search', aquiferResourceSearchResponseSchema, query);
}

/**
 * Fetch a single Aquifer resource by content id (TipTap body or media URLs).
 */
export async function getResource(contentId: number): Promise<Result<AquiferResourceDetails>> {
  return aquiferGet(`/resources/${contentId}`, aquiferResourceDetailsSchema);
}

/**
 * Paginate search until all items for the range are collected (or Aquifer errors).
 * Stops early on empty page, short page, total count reached, or MAX_SEARCH_PAGES.
 */
export async function searchAllResources(
  params: Omit<AquiferSearchResourcesParams, 'limit' | 'offset'>
): Promise<Result<AquiferResourceSearchResponse['items']>> {
  const allItems: AquiferResourceSearchResponse['items'] = [];
  let offset = 0;
  const limit = 100;

  for (let pageIndex = 0; pageIndex < MAX_SEARCH_PAGES; pageIndex += 1) {
    const page = await searchResources({ ...params, limit, offset });
    if (!page.ok) return page;

    allItems.push(...page.data.items);
    if (
      allItems.length >= page.data.totalItemCount ||
      page.data.items.length === 0 ||
      page.data.items.length < limit
    ) {
      break;
    }
    offset += limit;
  }

  return { ok: true, data: allItems };
}
