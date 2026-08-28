import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import env from '@/env';
import { ErrorCode } from '@/lib/types';

import {
  getBibles,
  getBibleText,
  getResource,
  searchAllResources,
  searchResources,
} from './aquifer.client';

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

    it('rejects a non-HTTPS base URL before sending the API key', async () => {
      const originalUrl = env.AQUIFER_API_URL;
      env.AQUIFER_API_URL = 'http://aquifer.example.test';
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      try {
        const result = await searchResources({
          bookCode: 'MRK',
          startChapter: 1,
          endChapter: 1,
          languageCode: 'eng',
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
          expect(result.error.message).toContain('must use HTTPS');
        }
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        env.AQUIFER_API_URL = originalUrl;
      }
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
        // The upstream body carries the real reason — it must reach the log.
        expect(result.error.message).toContain('bad key');
        expect(result.error.message).toContain('/resources/search');
      }
    });

    it('includes zod issue detail when the payload fails schema validation', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ totalItemCount: 'not-a-number', returnedItemCount: 0, offset: 0, items: [] })
      );

      const result = await searchResources({
        bookCode: 'MRK',
        startChapter: 1,
        endChapter: 1,
        languageCode: 'eng',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
        expect(result.error.message).toContain('schema validation');
        expect(result.error.message).toContain('totalItemCount');
        // Same response metadata the invalid-JSON path reports.
        expect(result.error.message).toContain('content-type: application/json');
        expect(result.error.message).toContain('chars');
      }
    });

    it('redacts credentials echoed back in an upstream error body', async () => {
      const leakyBody = JSON.stringify({
        message: 'rejected',
        'api-key': 'sk-live-abcdef123456',
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        echoedKey: env.AQUIFER_API_KEY,
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(leakyBody, 500));

      const result = await searchResources({
        bookCode: 'MRK',
        startChapter: 1,
        endChapter: 1,
        languageCode: 'eng',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).not.toContain('sk-live-abcdef123456');
        expect(result.error.message).not.toContain('eyJhbGciOiJIUzI1NiJ9');
        expect(result.error.message).not.toContain(env.AQUIFER_API_KEY);
        expect(result.error.message).toContain('[redacted]');
        // Non-secret diagnostic context must survive redaction.
        expect(result.error.message).toContain('HTTP 500');
        expect(result.error.message).toContain('rejected');
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

  describe('getBibles', () => {
    it('returns bibles for a language code', async () => {
      const body = [{ id: 1, name: 'BSB', abbreviation: 'BSB', hasAudio: true }];
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body));

      const result = await getBibles('eng');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data[0]?.abbreviation).toBe('BSB');
      }
    });
  });

  describe('getBibleText', () => {
    it('requests audio data by default', async () => {
      const body = {
        bibleId: 1,
        bibleName: 'BSB',
        bibleAbbreviation: 'BSB',
        bookName: 'Mark',
        bookCode: 'MRK',
        chapters: [
          {
            number: 14,
            audio: { mp3: { url: 'https://cdn.example/a.mp3', size: 100 } },
            verses: [{ number: 1, text: 'Hello' }],
          },
        ],
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body));

      const result = await getBibleText({
        aquiferBibleId: 1,
        bookCode: 'MRK',
        startChapter: 14,
        endChapter: 14,
      });

      expect(result.ok).toBe(true);
      const [url] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain('shouldReturnAudioData=true');
    });
  });
});
