import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import env from '@/env';
import { ErrorCode } from '@/lib/types';

import { getResource, searchAllResources, searchResources } from './aquifer.client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const searchItem = {
  id: 101,
  name: 'faith',
  localizedName: 'Faith',
  mediaType: 'Text' as const,
  languageCode: 'eng',
  grouping: {
    type: 'Guide' as const,
    name: 'Translation Notes',
    collectionTitle: 'Translation Notes',
    collectionCode: 'UWTranslationNotes',
  },
};

const searchBody = {
  totalItemCount: 1,
  returnedItemCount: 1,
  offset: 0,
  items: [searchItem],
};

const detailsBody = {
  id: 101,
  referenceId: 101,
  name: 'faith',
  localizedName: 'Faith',
  content: [{ tiptap: { type: 'doc', content: [] } }],
  grouping: { type: 'Guide', name: 'Guide', mediaType: 'Text' },
  language: { id: 1, code: 'eng', displayName: 'English', scriptDirection: 'LTR' },
};

describe('aquifer.client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('searchResources', () => {
    it('returns Result.ok with search items on success', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(searchBody));

      const result = await searchResources({
        bookCode: 'MRK',
        startChapter: 14,
        endChapter: 14,
        startVerse: 1,
        endVerse: 1,
        languageCode: 'eng',
        resourceCollectionCode: 'UWTranslationNotes',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items).toHaveLength(1);
        expect(result.data.items[0]?.id).toBe(101);
      }

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain(`${env.AQUIFER_API_URL}/resources/search`);
      expect(String(url)).toContain('BookCode=MRK');
      expect(String(url)).toContain('ResourceCollectionCode=UWTranslationNotes');
      expect(init).toMatchObject({
        method: 'GET',
        headers: expect.objectContaining({ 'api-key': env.AQUIFER_API_KEY }),
      });
      // Bodyless GET: sending Content-Type makes Aquifer 400 on the empty body.
      expect(init?.headers).not.toHaveProperty('Content-Type');
    });

    it('maps a non-2xx response to AQUIFER_SERVICE_UNAVAILABLE', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ detail: 'bad key' }, 401));

      const result = await searchResources({
        bookCode: 'MRK',
        startChapter: 1,
        endChapter: 1,
        languageCode: 'eng',
        resourceType: 'Images',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
        expect(result.error.message).toContain('HTTP 401');
      }
    });

    it('maps network failure to AQUIFER_SERVICE_UNAVAILABLE', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await searchResources({
        bookCode: 'MRK',
        startChapter: 1,
        endChapter: 1,
        languageCode: 'eng',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
        expect(result.error.message).toContain('ECONNREFUSED');
      }
    });

    it('maps malformed JSON to AQUIFER_SERVICE_UNAVAILABLE', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse('not-json{'));

      const result = await searchResources({
        bookCode: 'MRK',
        startChapter: 1,
        endChapter: 1,
        languageCode: 'eng',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
      }
    });
  });

  describe('getResource', () => {
    it('returns Result.ok with resource details', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(detailsBody));

      const result = await getResource(101);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.id).toBe(101);
        expect(result.data.localizedName).toBe('Faith');
      }
    });

    it('maps HTTP errors to AQUIFER_SERVICE_UNAVAILABLE', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 500));

      const result = await getResource(999);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
      }
    });
  });

  describe('searchAllResources', () => {
    it('paginates until all items are collected', async () => {
      const page1Items = Array.from({ length: 100 }, (_, index) => ({
        ...searchItem,
        id: index + 1,
        name: `item-${index + 1}`,
        localizedName: `Item ${index + 1}`,
      }));
      const page1 = {
        totalItemCount: 101,
        returnedItemCount: 100,
        offset: 0,
        items: page1Items,
      };
      const page2 = {
        totalItemCount: 101,
        returnedItemCount: 1,
        offset: 100,
        items: [{ ...searchItem, id: 101, name: 'last', localizedName: 'Last' }],
      };

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(page1))
        .mockResolvedValueOnce(jsonResponse(page2));

      const result = await searchAllResources({
        bookCode: 'MRK',
        startChapter: 14,
        endChapter: 14,
        languageCode: 'eng',
        startVerse: 1,
        endVerse: 200,
        resourceCollectionCode: 'UWTranslationNotes',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(101);
        expect(result.data.at(-1)?.id).toBe(101);
      }
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('stops pagination when a short page is returned', async () => {
      const shortPage = {
        totalItemCount: 500,
        returnedItemCount: 1,
        offset: 0,
        items: [searchItem],
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(shortPage));

      const result = await searchAllResources({
        bookCode: 'MRK',
        startChapter: 1,
        endChapter: 1,
        languageCode: 'eng',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
      }
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
