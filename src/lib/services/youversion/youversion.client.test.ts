import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import env from '@/env';
import { ErrorCode } from '@/lib/types';

import {
  getBibles,
  getChapterMeta,
  getChapterText,
  getPassage,
  isYouVersionConfigured,
} from './youversion.client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const mockBible = {
  id: 1,
  abbreviation: 'NIV',
  localized_abbreviation: 'NIV',
  title: 'New International Version',
  localized_title: 'New International Version',
  language_tag: 'eng',
};

const mockBiblesResponseBody = {
  data: [mockBible],
};

const mockChapterMetaResponseBody = {
  id: 101,
  passage_id: 'GEN.1',
  verses: [
    { id: 1, passage_id: 'GEN.1.1', human_reference: 'Genesis 1:1', usfm: ['v 1'] },
    { id: 2, passage_id: 'GEN.1.2', human_reference: 'Genesis 1:2', usfm: ['v 2'] },
  ],
};

const mockPassage1Body = {
  id: 'GEN.1.1',
  passage_id: 'GEN.1.1',
  content: 'In the beginning God created the heavens and the earth.',
};

const mockPassage2Body = {
  id: 'GEN.1.2',
  passage_id: 'GEN.1.2',
  content: 'Now the earth was formless and empty.',
};

describe('youversion.client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isYouVersionConfigured', () => {
    it('returns true when YOUVERSION_API_KEY is populated', () => {
      expect(isYouVersionConfigured()).toBe(true);
    });

    it('returns false when YOUVERSION_API_KEY is empty', () => {
      const original = env.YOUVERSION_API_KEY;
      env.YOUVERSION_API_KEY = '';
      try {
        expect(isYouVersionConfigured()).toBe(false);
      } finally {
        env.YOUVERSION_API_KEY = original;
      }
    });
  });

  describe('getBibles', () => {
    it('returns Result.ok with bibles list on success', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(jsonResponse(mockBiblesResponseBody));

      const result = await getBibles('eng');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]?.id).toBe(1);
        expect(result.data[0]?.abbreviation).toBe('NIV');
      }

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain(`${env.YOUVERSION_API_URL}/bibles`);
      expect(String(url)).toContain('language_tag=eng');
      expect(init).toMatchObject({
        method: 'GET',
        headers: expect.objectContaining({ 'x-yvp-app-key': env.YOUVERSION_API_KEY }),
      });
    });

    it('returns error when YOUVERSION_API_KEY is not configured', async () => {
      const originalKey = env.YOUVERSION_API_KEY;
      env.YOUVERSION_API_KEY = '';
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      try {
        const result = await getBibles('eng');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE);
          expect(result.error.message).toContain('not configured');
        }
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        env.YOUVERSION_API_KEY = originalKey;
      }
    });

    it('rejects non-HTTPS base URL before sending the API key', async () => {
      const originalUrl = env.YOUVERSION_API_URL;
      env.YOUVERSION_API_URL = 'http://youversion.example.test';
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      try {
        const result = await getBibles('eng');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE);
          expect(result.error.message).toContain('must use HTTPS');
        }
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        env.YOUVERSION_API_URL = originalUrl;
      }
    });

    it('maps non-2xx response to YOUVERSION_SERVICE_UNAVAILABLE', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ message: 'invalid key' }, 401)
      );

      const result = await getBibles('eng');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE);
        expect(result.error.message).toContain('HTTP 401');
        expect(result.error.message).toContain('invalid key');
      }
    });

    it('redacts credentials echoed back in upstream error body', async () => {
      const leakyBody = JSON.stringify({
        message: 'rejected',
        'x-yvp-app-key': 'secret-key-12345',
        echoedKey: env.YOUVERSION_API_KEY,
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(leakyBody, 500));

      const result = await getBibles('eng');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).not.toContain('secret-key-12345');
        expect(result.error.message).not.toContain(env.YOUVERSION_API_KEY);
        expect(result.error.message).toContain('[redacted]');
        expect(result.error.message).toContain('HTTP 500');
      }
    });

    it('maps network failure to YOUVERSION_SERVICE_UNAVAILABLE', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await getBibles('eng');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE);
        expect(result.error.message).toContain('ECONNREFUSED');
      }
    });

    it('maps malformed JSON response to YOUVERSION_SERVICE_UNAVAILABLE', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse('not-valid-json{'));

      const result = await getBibles('eng');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE);
        expect(result.error.message).toContain('not valid JSON');
      }
    });

    it('maps schema validation failure to YOUVERSION_SERVICE_UNAVAILABLE', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ data: 'not-an-array-of-bibles' })
      );

      const result = await getBibles('eng');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE);
        expect(result.error.message).toContain('schema validation');
      }
    });
  });

  describe('getChapterMeta', () => {
    it('returns chapter metadata with verse passage IDs', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(mockChapterMetaResponseBody));

      const result = await getChapterMeta(1, 'GEN', 1);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.id).toBe(101);
        expect(result.data.verses).toHaveLength(2);
        expect(result.data.verses[0]?.passage_id).toBe('GEN.1.1');
      }
    });
  });

  describe('getPassage', () => {
    it('returns verse passage text content', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(mockPassage1Body));

      const result = await getPassage(1, 'GEN.1.1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.id).toBe('GEN.1.1');
        expect(result.data.content).toBe('In the beginning God created the heavens and the earth.');
      }
    });
  });

  describe('getChapterText', () => {
    it('fetches chapter meta then fans out passage fetches for all verses', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(mockChapterMetaResponseBody))
        .mockResolvedValueOnce(jsonResponse(mockPassage1Body))
        .mockResolvedValueOnce(jsonResponse(mockPassage2Body));

      const result = await getChapterText(1, 'GEN', 1);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.bibleId).toBe(1);
        expect(result.data.bookId).toBe('GEN');
        expect(result.data.chapterId).toBe(1);
        expect(result.data.verses).toEqual([
          {
            verseNumber: 1,
            passageId: 'GEN.1.1',
            content: 'In the beginning God created the heavens and the earth.',
          },
          {
            verseNumber: 2,
            passageId: 'GEN.1.2',
            content: 'Now the earth was formless and empty.',
          },
        ]);
      }
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('returns empty verses list when chapter meta has no verses', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ id: 101, passage_id: 'GEN.1', verses: [] })
      );

      const result = await getChapterText(1, 'GEN', 1);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.verses).toHaveLength(0);
      }
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('fails the whole chapter when any passage fetch fails during fan-out', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(mockChapterMetaResponseBody))
        .mockResolvedValueOnce(jsonResponse(mockPassage1Body))
        .mockResolvedValueOnce(jsonResponse({ message: 'Verse 2 missing' }, 404));

      const result = await getChapterText(1, 'GEN', 1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE);
      }
    });

    it('returns failure if chapter meta fetch fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ message: 'Chapter not found' }, 404)
      );

      const result = await getChapterText(1, 'GEN', 999);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE);
      }
    });
  });

  // ─── Pagination ─────────────────────────────────────────────────────────────

  describe('getBibles — pagination', () => {
    it('accumulates results across multiple pages when next_page_token is present', async () => {
      const page1Bible = { ...mockBible, id: 1 };
      const page2Bible = {
        ...mockBible,
        id: 2,
        abbreviation: 'ESV',
        localized_abbreviation: 'ESV',
        title: 'English Standard Version',
        localized_title: 'English Standard Version',
      };

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ data: [page1Bible], next_page_token: 'tok-p2' }))
        .mockResolvedValueOnce(jsonResponse({ data: [page2Bible] }));

      const result = await getBibles('eng');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(2);
        expect(result.data.map((b) => b.id)).toEqual([1, 2]);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // Second call must include the page token from the first response.
      expect(String(fetchSpy.mock.calls[1]![0])).toContain('page_token=tok-p2');
    });

    it('returns YOUVERSION_SERVICE_UNAVAILABLE when the page cap is exceeded', async () => {
      // Use mockImplementation so each call gets a fresh Response (body streams are one-shot).
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() =>
          Promise.resolve(jsonResponse({ data: [mockBible], next_page_token: 'repeating' }))
        );

      const result = await getBibles('eng');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE);
        expect(result.error.message).toContain('page cap');
      }
      // Should have made exactly MAX_BIBLES_PAGES = 20 upstream calls before failing.
      expect(fetchSpy).toHaveBeenCalledTimes(20);
    });
  });

  // ─── 429 retry ──────────────────────────────────────────────────────────────

  describe('getChapterText — 429 retry', () => {
    const singleVerseMeta = {
      id: 101,
      passage_id: 'GEN.1',
      verses: [{ id: 1, passage_id: 'GEN.1.1', human_reference: 'Genesis 1:1', usfm: ['v 1'] }],
    };

    it('retries a 429 passage fetch and succeeds on the next attempt', async () => {
      vi.useFakeTimers();

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(singleVerseMeta))
        .mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many Requests' }))
        .mockResolvedValueOnce(jsonResponse(mockPassage1Body));

      const resultPromise = getChapterText(1, 'GEN', 1);
      // Advance past DEFAULT_RETRY_DELAY_MS * 1 = 1_000 ms
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.verses[0]?.verseNumber).toBe(1);
      }
      // meta + initial 429 + successful retry
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('uses the Retry-After header value as the retry delay when present', async () => {
      vi.useFakeTimers();

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(singleVerseMeta))
        .mockResolvedValueOnce(
          new Response('', {
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'Retry-After': '10' },
          })
        )
        .mockResolvedValueOnce(jsonResponse(mockPassage1Body));

      const resultPromise = getChapterText(1, 'GEN', 1);

      // Advance only 9 s — retry must not have fired yet.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2); // meta + initial 429 only

      // Advance past the full 10 s Retry-After window.
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('falls back to DEFAULT_RETRY_DELAY_MS * attempt when Retry-After is absent', async () => {
      vi.useFakeTimers();

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(singleVerseMeta))
        .mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many Requests' }))
        .mockResolvedValueOnce(jsonResponse(mockPassage1Body));

      const resultPromise = getChapterText(1, 'GEN', 1);

      // Advance only 500 ms — DEFAULT_RETRY_DELAY_MS * 1 = 1_000 ms, so retry must not fire yet.
      await vi.advanceTimersByTimeAsync(500);
      expect(fetchSpy).toHaveBeenCalledTimes(2); // meta + initial 429 only

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('returns error after exhausting MAX_429_RETRIES (3) retries', async () => {
      vi.useFakeTimers();

      // Use mockImplementation after the meta call so each 429 gets a fresh Response.
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(singleVerseMeta))
        // initial + 3 retries — all 429; factory ensures each gets a fresh body stream
        .mockImplementation(() =>
          Promise.resolve(new Response('', { status: 429, statusText: 'Too Many Requests' }))
        );

      const resultPromise = getChapterText(1, 'GEN', 1);
      // Cumulative retry delays: 1_000 + 2_000 + 3_000 = 6_000 ms
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE);
      }
      // meta + 4 passage fetches (initial + 3 retries)
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    });
  });

  // ─── Verse filtering and ordering ───────────────────────────────────────────

  describe('getChapterText — verse filtering and ordering', () => {
    it('skips non-numeric passage_id segments such as INTRO verses', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse({
            id: 101,
            passage_id: 'GEN.1',
            verses: [
              { id: 0, passage_id: 'GEN.1.INTRO', human_reference: 'Genesis 1 intro', usfm: [] },
              { id: 1, passage_id: 'GEN.1.1', human_reference: 'Genesis 1:1', usfm: ['v 1'] },
            ],
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({ id: 'GEN.1.INTRO', passage_id: 'GEN.1.INTRO', content: 'Intro text' })
        )
        .mockResolvedValueOnce(jsonResponse(mockPassage1Body));

      const result = await getChapterText(1, 'GEN', 1);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.verses).toHaveLength(1);
        expect(result.data.verses[0]?.verseNumber).toBe(1);
        expect(result.data.verses.map((v) => v.passageId)).not.toContain('GEN.1.INTRO');
      }
    });

    it('returns verses sorted ascending by verse number regardless of fetch completion order', async () => {
      // Meta lists verse 2 before verse 1 — output must still be [1, 2].
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse({
            id: 101,
            passage_id: 'GEN.1',
            verses: [
              { id: 2, passage_id: 'GEN.1.2', human_reference: 'Genesis 1:2', usfm: ['v 2'] },
              { id: 1, passage_id: 'GEN.1.1', human_reference: 'Genesis 1:1', usfm: ['v 1'] },
            ],
          })
        )
        .mockResolvedValueOnce(jsonResponse(mockPassage2Body))
        .mockResolvedValueOnce(jsonResponse(mockPassage1Body));

      const result = await getChapterText(1, 'GEN', 1);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.verses.map((v) => v.verseNumber)).toEqual([1, 2]);
      }
    });
  });
});
