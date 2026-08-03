import { z } from '@hono/zod-openapi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import env from '@/env';
import { ErrorCode } from '@/lib/types';

import { callFluentAi, triggerAiSuggestions } from './fluent-ai.client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const resultSchema = z.object({
  value: z.string(),
});

type TestResult = z.infer<typeof resultSchema>;

const TOOL_PATH = 'tools/greek-room/repeated-words';

function buildEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    job_id: '11111111-1111-1111-1111-111111111111',
    tool: 'greek_room.repeated_words',
    status: 'completed',
    result: { value: 'ok' },
    error: null,
    created_at: '2026-06-02T00:00:00Z',
    completed_at: '2026-06-02T00:00:01Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('callFluentAi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Happy paths ─────────────────────────────────────────────────────────

  it('returns Result.ok with the full envelope on a completed status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(buildEnvelope()));

    const result = await callFluentAi<unknown, TestResult>(TOOL_PATH, {}, resultSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('completed');
      expect(result.data.result).toEqual({ value: 'ok' });
      expect(result.data.job_id).toBe('11111111-1111-1111-1111-111111111111');
    }
  });

  it('returns Result.ok for a queued envelope without validating the (null) result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(buildEnvelope({ status: 'queued', result: null, completed_at: null }))
    );

    const result = await callFluentAi<unknown, TestResult>(TOOL_PATH, {}, resultSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('queued');
      expect(result.data.result).toBeNull();
    }
  });

  // ─── Terminal failures ───────────────────────────────────────────────────

  it('maps status "failed" to AI_TOOL_EXECUTION_FAILED', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        buildEnvelope({
          status: 'failed',
          result: null,
          error: { code: 'TOOL_EXECUTION_ERROR', message: 'tool blew up' },
        })
      )
    );

    const result = await callFluentAi<unknown, TestResult>(TOOL_PATH, {}, resultSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AI_TOOL_EXECUTION_FAILED);
      expect(result.error.message).toContain('tool blew up');
    }
  });

  it('maps status "cancelled" to AI_TOOL_EXECUTION_FAILED', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(buildEnvelope({ status: 'cancelled', result: null }))
    );

    const result = await callFluentAi<unknown, TestResult>(TOOL_PATH, {}, resultSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AI_TOOL_EXECUTION_FAILED);
    }
  });

  // ─── Transport / HTTP errors ───────────────────────────────────────────────

  it('maps a 4xx response to AI_SERVICE_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ detail: 'bad key' }, 401));

    const result = await callFluentAi<unknown, TestResult>(TOOL_PATH, {}, resultSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AI_SERVICE_UNAVAILABLE);
    }
  });

  it('maps a 5xx response to AI_SERVICE_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ detail: 'boom' }, 500));

    const result = await callFluentAi<unknown, TestResult>(TOOL_PATH, {}, resultSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AI_SERVICE_UNAVAILABLE);
    }
  });

  it('maps a rejected fetch (network error) to AI_SERVICE_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const result = await callFluentAi<unknown, TestResult>(TOOL_PATH, {}, resultSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AI_SERVICE_UNAVAILABLE);
      expect(result.error.message).toContain('unreachable');
    }
  });

  // ─── Parsing / schema validation ───────────────────────────────────────────

  it('maps a non-JSON body to AI_SERVICE_UNAVAILABLE with a "malformed" message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse('not-json-at-all'));

    const result = await callFluentAi<unknown, TestResult>(TOOL_PATH, {}, resultSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AI_SERVICE_UNAVAILABLE);
      expect(result.error.message.toLowerCase()).toContain('malformed');
    }
  });

  it('maps a result that fails the result schema to AI_SERVICE_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(buildEnvelope({ result: { value: 123 } }))
    );

    const result = await callFluentAi<unknown, TestResult>(TOOL_PATH, {}, resultSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AI_SERVICE_UNAVAILABLE);
    }
  });

  // ─── Timeout / abort ───────────────────────────────────────────────────────

  it('maps the default timeout firing to AI_SERVICE_UNAVAILABLE', async () => {
    vi.useFakeTimers();
    // Simulate fetch rejecting with an AbortError when the derived signal aborts.
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

    const promise = callFluentAi<unknown, TestResult>(TOOL_PATH, {}, resultSchema, {
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AI_SERVICE_UNAVAILABLE);
      expect(result.error.message).toContain('timed out');
    }
  });

  it('maps a caller-supplied AbortSignal abort to AI_SERVICE_UNAVAILABLE', async () => {
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

    const promise = callFluentAi<unknown, TestResult>(TOOL_PATH, {}, resultSchema, {
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.AI_SERVICE_UNAVAILABLE);
    }
  });

  // ─── Request shape ─────────────────────────────────────────────────────────

  it('sends the correct URL, headers, and JSON body (default empty prefix)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(buildEnvelope()));

    const body = { lang_code: 'eng', verses: [{ snt_id: 'GEN 1:1', text: 'In in' }] };
    await callFluentAi(TOOL_PATH, body, resultSchema);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];

    // The live fluent-ai build mounts routers at the root, so with the default
    // empty FLUENT_AI_API_PREFIX the URL carries no version segment.
    expect(url).toBe(`${env.FLUENT_AI_URL}/${TOOL_PATH}`);
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-API-Key']).toBe(env.FLUENT_AI_KEY);
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('inserts a configured FLUENT_AI_API_PREFIX between base URL and tool path', async () => {
    // env is read at call time, so we can flip the prefix for this one case and
    // restore it afterward. Covers the forward-compat path (fluent-ai adopting
    // a versioned mount such as /api/v1) without a code change.
    const original = env.FLUENT_AI_API_PREFIX;
    const cases: { prefix: string; expected: string }[] = [
      { prefix: '/api/v1', expected: `${env.FLUENT_AI_URL}/api/v1/${TOOL_PATH}` },
      { prefix: 'api/v1', expected: `${env.FLUENT_AI_URL}/api/v1/${TOOL_PATH}` },
      { prefix: '/api/v1/', expected: `${env.FLUENT_AI_URL}/api/v1/${TOOL_PATH}` },
    ];

    try {
      for (const { prefix, expected } of cases) {
        env.FLUENT_AI_API_PREFIX = prefix;
        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(jsonResponse(buildEnvelope()));

        await callFluentAi(TOOL_PATH, {}, resultSchema);

        const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(expected);
        vi.restoreAllMocks();
      }
    } finally {
      env.FLUENT_AI_API_PREFIX = original;
    }
  });
});

describe('triggerAiSuggestions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('triggers AI suggestions successfully when fetch resolves HTTP 200', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));

    const payloads = [
      {
        projectUnitId: 1,
        bibleId: 2,
        bookCode: 'GEN',
        chapterNumber: 1,
        verseStart: 1,
        verseEnd: 1,
      },
    ];
    await expect(triggerAiSuggestions(payloads)).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${env.FLUENT_AI_URL}/suggestions`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(payloads);
  });

  it('throws an error when HTTP response is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 })
    );

    await expect(triggerAiSuggestions([])).rejects.toThrow(
      'fluent-ai returned HTTP 500: Internal Server Error'
    );
  });

  it('throws a timeout error when request is aborted via AbortError', async () => {
    afterEach(() => {
      vi.useRealTimers();
    });
  });
});
