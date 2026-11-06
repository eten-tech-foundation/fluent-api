/**
 * Fail-closed Aquifer fetch fixtures for prepare-offline content-contract tests.
 * Sanitized JSON only — never live provider traffic.
 */
import { expect, vi } from 'vitest';

import env from '@/env';

type SearchKey =
  'UWTranslationNotes' | 'UWTranslationWords' | 'UWTranslationQuestions' | 'StudyNotes' | 'Images';

interface SearchHitFixture {
  id: number;
  name: string;
  localizedName: string;
  mediaType: string;
  languageCode: string;
  grouping: {
    type: string;
    name: string;
    collectionTitle?: string;
    collectionCode?: string;
  };
}

interface DetailFixture {
  id: number;
  name: string;
  localizedName: string;
  content: unknown;
  grouping: Record<string, unknown>;
  language?: Record<string, unknown>;
  referenceId?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptySearchPage(offset = 0) {
  return {
    totalItemCount: 0,
    returnedItemCount: 0,
    offset,
    items: [] as SearchHitFixture[],
  };
}

export function searchPage(items: SearchHitFixture[], totalItemCount = items.length, offset = 0) {
  return {
    totalItemCount,
    returnedItemCount: items.length,
    offset,
    items,
  };
}

export function textHit(id: number, collectionCode = 'UWTranslationNotes'): SearchHitFixture {
  return {
    id,
    name: `resource-${id}`,
    localizedName: `Resource ${id}`,
    mediaType: 'Text',
    languageCode: 'eng',
    grouping: {
      type: 'Guide',
      name: collectionCode,
      collectionTitle: collectionCode,
      collectionCode,
    },
  };
}

/** Minimal TipTap-shaped body; JSON.stringify byte length is 27. */
export const VALID_CONTENT_27B = { type: 'doc', content: [] as unknown[] };

export function textDetails(id: number, content: unknown = VALID_CONTENT_27B): DetailFixture {
  return {
    id,
    referenceId: id,
    name: `resource-${id}`,
    localizedName: `Resource ${id}`,
    content,
    grouping: { type: 'Guide', name: 'Guide', mediaType: 'Text' },
    language: { id: 1, code: 'eng', displayName: 'English', scriptDirection: 'LTR' },
  };
}

/**
 * Fail-closed Aquifer fetch stub. Unexpected URLs / exhausted configured pages
 * are recorded and thrown — never silently completed. Callers must assert
 * unexpectedCalls is empty after expected runs (client maps throws to unavailable).
 */
export function installAquiferFetchStub(options: {
  searchPages?: Partial<Record<SearchKey, unknown[]>>;
  detailsById?: Record<number, unknown | Response>;
}) {
  const searchPages: Record<SearchKey, unknown[]> = {
    UWTranslationNotes: [emptySearchPage()],
    UWTranslationWords: [emptySearchPage()],
    UWTranslationQuestions: [emptySearchPage()],
    StudyNotes: [emptySearchPage()],
    Images: [emptySearchPage()],
    ...options.searchPages,
  };
  const searchOffsets: Record<SearchKey, number> = {
    UWTranslationNotes: 0,
    UWTranslationWords: 0,
    UWTranslationQuestions: 0,
    StudyNotes: 0,
    Images: 0,
  };
  const detailsById = options.detailsById ?? {};
  const unexpectedCalls: string[] = [];

  const recordUnexpected = (message: string): never => {
    unexpectedCalls.push(message);
    throw new Error(message);
  };

  const resolveSearchKey = (url: URL): SearchKey | undefined => {
    const collection = url.searchParams.get('ResourceCollectionCode');
    const resourceType = url.searchParams.get('ResourceType');
    if (collection === 'UWTranslationNotes') return 'UWTranslationNotes';
    if (collection === 'UWTranslationWords') return 'UWTranslationWords';
    if (collection === 'UWTranslationQuestions') return 'UWTranslationQuestions';
    if (resourceType === 'StudyNotes') return 'StudyNotes';
    if (resourceType === 'Images') return 'Images';
    return undefined;
  };

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.origin !== new URL(env.AQUIFER_API_URL).origin) {
      return recordUnexpected(`Unexpected fetch origin (fail-closed): ${url.origin}`);
    }

    if (url.pathname === '/resources/search') {
      const key = resolveSearchKey(url);
      if (!key) {
        return recordUnexpected(`Unexpected Aquifer search query (fail-closed): ${url.toString()}`);
      }
      const pages = searchPages[key];
      const pageIndex = searchOffsets[key];
      if (pageIndex >= pages.length) {
        return recordUnexpected(
          `Unexpected exhausted search page (fail-closed): ${key} pageIndex=${pageIndex}`
        );
      }
      searchOffsets[key] = pageIndex + 1;
      return jsonResponse(pages[pageIndex]);
    }

    const detailMatch = /^\/resources\/(\d+)$/.exec(url.pathname);
    if (detailMatch) {
      const id = Number(detailMatch[1]);
      const detail = detailsById[id];
      if (detail instanceof Response) return detail;
      if (detail !== undefined) return jsonResponse(detail);
      return recordUnexpected(`Unexpected Aquifer getResource id (fail-closed): ${id}`);
    }

    return recordUnexpected(`Unexpected Aquifer fetch path (fail-closed): ${url.pathname}`);
  });

  return {
    unexpectedCalls,
    expectNoUnexpectedCalls: () => {
      expect(unexpectedCalls).toEqual([]);
    },
  };
}
