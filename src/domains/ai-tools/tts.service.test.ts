import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@/lib/types';

import { fetchTtsAudio, generateTtsAudio } from './tts.service';

/**
 * Service-level tests for the Source-TTS upstream calls.
 *
 * These exist separately from tts.route.test.ts because the two most important
 * guarantees in this phase are properties of the FETCH OPTIONS, which a mocked
 * service would hide completely:
 *   1. `redirect: 'manual'` on get-audio (§7.3);
 *   2. the deliberate ABSENCE of a timeout on get-audio.
 * Both are invisible from the route layer, and both are silently "fine" in
 * development while being wrong in production — so they are pinned here.
 */

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const HASH = '9f2ac1d47bfe3a5c8e1d0b6a4f7c2e91';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The options object handed to fetch on the single call made. */
function fetchOptions(): RequestInit {
  expect(fetchMock).toHaveBeenCalledOnce();
  return fetchMock.mock.calls[0][1] as RequestInit;
}

function fetchUrl(): string {
  return String(fetchMock.mock.calls[0][0]);
}

describe('fetchTtsAudio', () => {
  it('uses redirect: manual so a 302 is returned rather than followed', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://cdn.example/x.ogg' } })
    );

    const result = await fetchTtsAudio(HASH, 'wav', { method: 'GET' });

    // THE line this phase is most likely to lose in a refactor. Node's fetch
    // defaults to `redirect: 'follow'`, which would make fluent-api quietly
    // download the immutable artifact and re-stream it — working, but two-hopping
    // every byte through the proxy and reopening the Range-consistency hazard the
    // redirect design exists to remove.
    expect(fetchOptions().redirect).toBe('manual');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe(302);
      expect(result.data.headers.get('location')).toBe('https://cdn.example/x.ogg');
    }
  });

  it('does not impose a timeout — a first listen is a live stream', async () => {
    fetchMock.mockResolvedValue(new Response('audio', { status: 200 }));

    await fetchTtsAudio(HASH, 'wav', { method: 'GET' });

    // A generate-style 30s cap here would guillotine a long verse mid-sentence.
    // With no caller signal there must be no signal at all; cancellation is the
    // client's to initiate, not a wall clock's.
    expect(fetchOptions().signal).toBeUndefined();
  });

  it('ties the upstream read to the caller-supplied signal', async () => {
    fetchMock.mockResolvedValue(new Response('audio', { status: 200 }));
    const controller = new AbortController();

    await fetchTtsAudio(HASH, 'wav', { method: 'GET', signal: controller.signal });

    expect(fetchOptions().signal).toBe(controller.signal);
  });

  it('authenticates to fluent-ai and requests the exact hash and extension', async () => {
    fetchMock.mockResolvedValue(new Response('audio', { status: 200 }));

    await fetchTtsAudio(HASH, 'ogg', { method: 'GET' });

    const headers = fetchOptions().headers as Record<string, string>;
    expect(headers['X-API-Key']).toBeTruthy();
    expect(fetchUrl()).toContain(`tts/audio/${HASH}.ogg`);
  });

  it('forwards HEAD as HEAD', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await fetchTtsAudio(HASH, 'wav', { method: 'HEAD' });

    expect(fetchOptions().method).toBe('HEAD');
  });

  it('returns the upstream response unread so the body can be streamed', async () => {
    const upstream = new Response('RIFFfake', { status: 200 });
    fetchMock.mockResolvedValue(upstream);

    const result = await fetchTtsAudio(HASH, 'wav', { method: 'GET' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Nothing in the service may consume the body: the route hands this stream
      // straight to the client.
      expect(result.data.bodyUsed).toBe(false);
      expect(result.data).toBe(upstream);
    }
  });

  it('reports a transport failure as an upstream error, never as a 503', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await fetchTtsAudio(HASH, 'wav', { method: 'GET' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 503 is reserved for fluent-ai's admission gate and must only ever be
      // relayed, so an unreachable upstream maps to a distinct code (→ 502).
      expect(result.error.code).toBe(ErrorCode.AI_SERVICE_UNAVAILABLE);
    }
  });

  it('relays a 503 as a successful fetch, leaving the status to the route', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 503, headers: { 'retry-after': '5' } })
    );

    const result = await fetchTtsAudio(HASH, 'wav', { method: 'GET' });

    // An upstream 503 is NOT a service error — it is a meaningful answer that must
    // reach the client intact, so the service must not convert it into a failure.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe(503);
      expect(result.data.headers.get('retry-after')).toBe('5');
    }
  });
});

describe('generateTtsAudio', () => {
  const OK_BODY = { audioUrl: 'audio/9f2ac1d47bfe3a5c8e1d0b6a4f7c2e91.wav' };

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('posts the request to the mirrored generate tail with the api key', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OK_BODY));

    await generateTtsAudio({ text: 'hello' });

    const options = fetchOptions();
    expect(options.method).toBe('POST');
    expect((options.headers as Record<string, string>)['X-API-Key']).toBeTruthy();
    // Sibling of the audio tail — `audioUrl` is relative and resolves against it.
    expect(fetchUrl()).toContain('tts/generate');
    expect(JSON.parse(options.body as string)).toEqual({ text: 'hello' });
  });

  it('preserves unknown response fields instead of stripping them', async () => {
    const upstream = { ...OK_BODY, voiceUsed: 'en-US-Wavenet-D', futureField: [1, 2] };
    fetchMock.mockResolvedValue(jsonResponse(upstream));

    const result = await generateTtsAudio({ text: 'hello' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The response schema is `.passthrough()` precisely so a field fluent-ai
      // adds later reaches the browser rather than dying in the proxy. This is the
      // asymmetry with the `.strict()` REQUEST schema, and it is deliberate.
      expect(result.data).toEqual(upstream);
    }
  });

  it('does not invent a format when the caller omitted one', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OK_BODY));

    await generateTtsAudio({ text: 'hello' });

    const sent = JSON.parse(fetchOptions().body as string);
    // fluent-ai resolves TTS_DEFAULT_FORMAT before hashing; supplying a default
    // here would fork the content hash and split the cache.
    expect('format' in sent).toBe(false);
  });

  it('fails when the response is missing audioUrl', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ notTheField: true }));

    const result = await generateTtsAudio({ text: 'hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AI_SERVICE_UNAVAILABLE);
    }
  });

  it('fails when the response body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway error</html>', { status: 200 }));

    const result = await generateTtsAudio({ text: 'hello' });

    expect(result.ok).toBe(false);
  });

  it('fails when fluent-ai answers a non-2xx status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'nope' }, 500));

    const result = await generateTtsAudio({ text: 'hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('500');
    }
  });

  it('applies a timeout signal when the caller supplies none', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OK_BODY));

    await generateTtsAudio({ text: 'hello' });

    // Unlike get-audio, generate synthesizes nothing and must not hang forever.
    expect(fetchOptions().signal).toBeInstanceOf(AbortSignal);
  });
});
