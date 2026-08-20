import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@/lib/types';

import type { DblClientConfig } from './dbl.client';

import { createDblClient, dblConfigFromEnv } from './dbl.client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_URL = 'https://rest.api.bible/v1';
const API_KEY = 'test-dbl-key';

function configuredConfig(overrides: Partial<DblClientConfig> = {}): DblClientConfig {
  return { baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 30_000, ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const bibleFixture = {
  id: '78a9f6124f344018-01',
  dblId: 'dbl-id',
  abbreviation: 'NIV',
  abbreviationLocal: 'NIV',
  language: {
    id: 'eng',
    name: 'English',
    nameLocal: 'English',
    script: 'Latin',
    scriptDirection: 'LTR',
  },
  countries: [{ id: 'US', name: 'United States', nameLocal: 'United States' }],
  name: 'New International Version',
  nameLocal: 'New International Version',
  description: null,
  descriptionLocal: null,
  relatedDbl: null,
  type: 'text',
  updatedAt: '2026-01-01T00:00:00.000Z',
  audioBibles: [],
};

describe('createDblClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Not configured ────────────────────────────────────────────────────────

  it('returns DBL_NOT_CONFIGURED without calling fetch when apiKey is empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = createDblClient(configuredConfig({ apiKey: '' }));

    const result = await client.getBibles();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.DBL_NOT_CONFIGURED);
    }
  });

  // ─── Happy paths ─────────────────────────────────────────────────────────

  it('returns Result.ok with a parsed Bible list on GET /bibles', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [bibleFixture] }));
    const client = createDblClient(configuredConfig());

    const result = await client.getBibles();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.abbreviation).toBe('NIV');
    }
  });

  it('returns Result.ok with a parsed single Bible on GET /bibles/{bibleId}', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: { ...bibleFixture, copyright: 'copyright text' } })
    );
    const client = createDblClient(configuredConfig());

    const result = await client.getBible(bibleFixture.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe(bibleFixture.id);
      expect(result.data.copyright).toBe('copyright text');
    }
  });

  it('returns Result.ok with chapter content on GET /bibles/{bibleId}/chapters/{chapterId}', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: {
          id: 'GEN.1',
          bibleId: bibleFixture.id,
          number: '1',
          bookId: 'GEN',
          content: '<p>In the beginning...</p>',
          reference: 'Genesis 1',
          verseCount: 31,
          next: { id: 'GEN.2', bookId: 'GEN', number: '2' },
          previous: null,
          copyright: 'copyright text',
        },
      })
    );
    const client = createDblClient(configuredConfig());

    const result = await client.getChapter(bibleFixture.id, 'GEN.1', { contentType: 'html' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.reference).toBe('Genesis 1');
      expect(result.data.content).toContain('In the beginning');
    }
  });

  // ─── Transport / HTTP errors ───────────────────────────────────────────────

  it('maps a 401 response to DBL_SERVICE_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'bad key' }, 401));
    const client = createDblClient(configuredConfig());

    const result = await client.getBible(bibleFixture.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.DBL_SERVICE_UNAVAILABLE);
      expect(result.error.message).toContain('401');
    }
  });

  it('maps a 404 response to DBL_SERVICE_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'not found' }, 404));
    const client = createDblClient(configuredConfig());

    const result = await client.getBible('unknown-bible-id');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.DBL_SERVICE_UNAVAILABLE);
    }
  });

  it('maps a rejected fetch (network error) to DBL_SERVICE_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const client = createDblClient(configuredConfig());

    const result = await client.getBibles();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.DBL_SERVICE_UNAVAILABLE);
      expect(result.error.message).toContain('unreachable');
    }
  });

  // ─── Parsing / schema validation ───────────────────────────────────────────

  it('maps a non-JSON body to DBL_SERVICE_UNAVAILABLE with a "malformed" message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse('not-json-at-all'));
    const client = createDblClient(configuredConfig());

    const result = await client.getBibles();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.DBL_SERVICE_UNAVAILABLE);
      expect(result.error.message.toLowerCase()).toContain('malformed');
    }
  });

  it('maps a payload that fails schema validation to DBL_SERVICE_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: { oops: true } }));
    const client = createDblClient(configuredConfig());

    const result = await client.getBible(bibleFixture.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.DBL_SERVICE_UNAVAILABLE);
    }
  });

  // ─── Timeout / abort ───────────────────────────────────────────────────────

  it('maps the configured timeout firing to DBL_SERVICE_UNAVAILABLE', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        })
    );
    const client = createDblClient(configuredConfig({ timeoutMs: 100 }));

    const promise = client.getBibles();
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.DBL_SERVICE_UNAVAILABLE);
      expect(result.error.message).toContain('timed out');
    }
  });

  it('maps a caller-supplied AbortSignal abort to DBL_SERVICE_UNAVAILABLE', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        })
    );
    const client = createDblClient(configuredConfig());

    const promise = client.getBibles(undefined, { signal: controller.signal });
    controller.abort();
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.DBL_SERVICE_UNAVAILABLE);
    }
  });

  // ─── Request shape ─────────────────────────────────────────────────────────

  it('sends the api-key header and no query string when no params are given', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }));
    const client = createDblClient(configuredConfig());

    await client.getBibles();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/bibles`);
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe(API_KEY);
  });

  it('serializes list/content params into the query string', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }));
    const client = createDblClient(configuredConfig());

    await client.getBibles({ language: 'eng', ids: ['id-1', 'id-2'], includeFullDetails: true });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('language')).toBe('eng');
    expect(parsed.searchParams.get('ids')).toBe('id-1,id-2');
    expect(parsed.searchParams.get('include-full-details')).toBe('true');
  });

  it('builds nested Bible/Book/Chapter/Verse paths with encoded IDs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: {
          id: 'GEN.1.1',
          orgId: 'GEN.1.1',
          bibleId: bibleFixture.id,
          bookId: 'GEN',
          chapterId: 'GEN.1',
          content: 'In the beginning...',
          reference: 'Genesis 1:1',
          verseCount: 1,
          copyright: null,
          next: null,
          previous: null,
        },
      })
    );
    const client = createDblClient(configuredConfig());

    await client.getVerse(bibleFixture.id, 'GEN.1.1', { contentType: 'text' });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${BASE_URL}/bibles/${encodeURIComponent(bibleFixture.id)}/verses/GEN.1.1?content-type=text`
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

// vi.mock requires variables to be hoisted if accessed inside the factory
const mockEnv = vi.hoisted(() => ({
  DBL_API_BASE_URL: 'https://rest.api.bible/v1',
  DBL_API_KEY: 'test-dbl-key',
  DBL_API_TIMEOUT_MS: 30_000,
}));

vi.mock('@/env', () => ({
  default: mockEnv,
}));

describe('dblConfigFromEnv', () => {
  it('passes env values directly to config', () => {
    const config = dblConfigFromEnv();

    expect(config.baseUrl).toBe('https://rest.api.bible/v1');
    expect(config.apiKey).toBe('test-dbl-key');
    expect(config.timeoutMs).toBe(30_000);
  });
});
