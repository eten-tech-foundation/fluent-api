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

async function aquiferGet<T>(
  path: string,
  schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false } },
  query?: URLSearchParams,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Result<T>> {
  if (!isAquiferConfigured()) {
    return aquiferError(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE, 'AQUIFER_API_KEY is not configured');
  }

  const url = buildUrl(path, query);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let rawBody: string;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'api-key': env.AQUIFER_API_KEY!,
      },
      signal: controller.signal,
    });
    rawBody = await response.text();
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      return aquiferError(
        ErrorCode.AQUIFER_SERVICE_UNAVAILABLE,
        `request timed out after ${timeoutMs}ms`
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    return aquiferError(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE, `Aquifer unreachable (${cause})`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    return aquiferError(
      ErrorCode.AQUIFER_SERVICE_UNAVAILABLE,
      `Aquifer returned HTTP ${response.status}`
    );
  }

  const parsed = rawBody.trim() ? safeJsonParse(rawBody) : {};
  if (parsed === undefined) {
    return aquiferError(
      ErrorCode.AQUIFER_SERVICE_UNAVAILABLE,
      'malformed response from Aquifer (body was not valid JSON)'
    );
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return aquiferError(
      ErrorCode.AQUIFER_SERVICE_UNAVAILABLE,
      'malformed response payload from Aquifer'
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
