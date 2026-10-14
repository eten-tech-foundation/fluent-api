import { afterEach, describe, expect, it, vi } from 'vitest';

import { BtServantClient } from './assistant.client';

function response(chunks: string[], status = 200, headers?: HeadersInit) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { status, headers }
  );
}

const options = {
  baseUrl: 'https://bt.invalid',
  engineKey: 'not-a-real-secret',
  org: 'fluent',
  connectMs: 100,
  idleMs: 100,
  totalMs: 100,
  maxOutputBytes: 20,
  maxFrameBytes: 1_000,
};

async function collect(client: BtServantClient) {
  const events = [];
  for await (const event of client.stream({
    userId: 'fluent_1',
    message: 'x',
    responseLanguageHint: 'en',
  }))
    events.push(event);
  return events;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BT stream normalization'.toLowerCase(), () => {
  it('constructs the direct BT request with reset history and suppression controls', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const client = new BtServantClient({
      ...options,
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return response(['data: {"type":"complete","response":{"responses":["answer"]}}\n\n']);
      },
    });
    await collect(client);
    expect(capturedUrl).toBe('https://bt.invalid/api/v1/chat/stream');
    expect(capturedInit?.method).toBe('POST');
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      client_id: 'fluent-passage-briefing',
      user_id: 'fluent_1',
      message_type: 'text',
      org: 'fluent',
      message: 'x',
      history: [],
      suppress_welcome: true,
      suppress_memory: true,
      response_language_hint: 'en',
    });
  });

  it('handles split CRLF frames, comments, unknown events, and exact completion', async () => {
    const body =
      ': keepalive\r\n\r\ndata: {"type":"status"}\r\n\r\ndata: {"type":"progress","text":"hel"}\r\n\r\ndata: {"type":"progress","text":"lo"}\r\n\r\ndata: {"type":"complete","response":{"responses":["hello"]}}\r\n\r\n';
    const client = new BtServantClient({
      ...options,
      fetch: async () => response([body.slice(0, 31), body.slice(31)]),
    });
    expect(await collect(client)).toEqual([
      { type: 'briefing_delta', delta: 'hel' },
      { type: 'briefing_delta', delta: 'lo' },
      { type: 'briefing_complete', markdown: 'hello' },
    ]);
  });

  it('rejects final/delta mismatch and unexpected EOF without provider content', async () => {
    const mismatch = new BtServantClient({
      ...options,
      fetch: async () =>
        response([
          'data: {"type":"progress","text":"a"}\n\ndata: {"type":"complete","response":{"responses":["b"]}}\n\n',
        ]),
    });
    expect((await collect(mismatch)).at(-1)).toEqual({
      type: 'briefing_error',
      code: 'malformed_upstream_response',
      retryable: false,
    });
    const eof = new BtServantClient({
      ...options,
      fetch: async () => response(['data: {"type":"status"}\n\n']),
    });
    expect(await collect(eof)).toEqual([
      { type: 'briefing_error', code: 'malformed_upstream_response', retryable: false },
    ]);
  });

  it('normalizes malformed and upstream error events without leaking their content', async () => {
    const malformed = new BtServantClient({
      ...options,
      fetch: async () => response(['data: {not-json}\n\n']),
    });
    expect(await collect(malformed)).toEqual([
      { type: 'briefing_error', code: 'malformed_upstream_response', retryable: false },
    ]);
    const upstream = new BtServantClient({
      ...options,
      fetch: async () =>
        response([
          'data: {"type":"error","message":"private provider detail","limit":"bt-secret-limit"}\n\n',
        ]),
    });
    const events = await collect(upstream);
    expect(events).toEqual([
      { type: 'briefing_error', code: 'temporarily_unavailable', retryable: true },
    ]);
    expect(JSON.stringify(events)).not.toContain('private provider detail');
    expect(JSON.stringify(events)).not.toContain('bt-secret-limit');
  });

  it('emits a complete-only BT response as one final delta before completion', async () => {
    const client = new BtServantClient({
      ...options,
      fetch: async () =>
        response(['data: {"type":"complete","response":{"responses":["complete only"]}}\n\n']),
    });
    expect(await collect(client)).toEqual([
      { type: 'briefing_delta', delta: 'complete only' },
      { type: 'briefing_complete', markdown: 'complete only' },
    ]);
  });

  it.each([
    { responses: [{}] },
    { responses: [1] },
    { responses: [null] },
    { responses: { zero: 'answer' } },
  ])(
    'rejects non-string complete response arrays and non-array response shapes',
    async ({ responses }) => {
      const client = new BtServantClient({
        ...options,
        fetch: async () =>
          response([`data: ${JSON.stringify({ type: 'complete', response: { responses } })}\n\n`]),
      });
      expect(await collect(client)).toEqual([
        { type: 'briefing_error', code: 'malformed_upstream_response', retryable: false },
      ]);
    }
  );

  it('enforces final-only output size before emitting any delta', async () => {
    const client = new BtServantClient({
      ...options,
      maxOutputBytes: 1,
      fetch: async () =>
        response(['data: {"type":"complete","response":{"responses":["ab"]}}\n\n']),
    });
    expect(await collect(client)).toEqual([
      { type: 'briefing_error', code: 'context_too_large', retryable: false },
    ]);
  });

  it('normalizes rate limiting and enforces one-byte output overflow', async () => {
    const limited = new BtServantClient({
      ...options,
      fetch: async () => response([], 429, { 'retry-after': '7' }),
    });
    expect(await collect(limited)).toEqual([
      { type: 'briefing_error', code: 'rate_limited', retryable: true, retryAfter: 7 },
    ]);
    const overflow = new BtServantClient({
      ...options,
      maxOutputBytes: 1,
      fetch: async () => response(['data: {"type":"progress","text":"ab"}\n\n']),
    });
    expect(await collect(overflow)).toEqual([
      { type: 'briefing_error', code: 'context_too_large', retryable: false },
    ]);
    const exact = new BtServantClient({
      ...options,
      maxOutputBytes: 2,
      fetch: async () =>
        response([
          'data: {"type":"progress","text":"ab"}\n\ndata: {"type":"complete","response":{"responses":["ab"]}}\n\n',
        ]),
    });
    expect(await collect(exact)).toEqual([
      { type: 'briefing_delta', delta: 'ab' },
      { type: 'briefing_complete', markdown: 'ab' },
    ]);
  });

  it('normalizes Retry-After delta-seconds and HTTP-date forms', async () => {
    const delta = new BtServantClient({
      ...options,
      fetch: async () => response([], 429, { 'retry-after': '0' }),
    });
    expect(await collect(delta)).toEqual([
      { type: 'briefing_error', code: 'rate_limited', retryable: true, retryAfter: 0 },
    ]);

    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const dated = new BtServantClient({
      ...options,
      fetch: async () => response([], 429, { 'retry-after': new Date(now + 10_000).toUTCString() }),
    });
    expect(await collect(dated)).toEqual([
      { type: 'briefing_error', code: 'rate_limited', retryable: true, retryAfter: 10 },
    ]);
    const past = new BtServantClient({
      ...options,
      fetch: async () => response([], 429, { 'retry-after': new Date(now - 10_000).toUTCString() }),
    });
    expect(await collect(past)).toEqual([
      { type: 'briefing_error', code: 'rate_limited', retryable: true, retryAfter: 0 },
    ]);
  });

  it.each(['-1', 'Infinity', 'garbage', '1.5'])(
    'omits invalid Retry-After value %s',
    async (retryAfter) => {
      const client = new BtServantClient({
        ...options,
        fetch: async () => response([], 429, { 'retry-after': retryAfter }),
      });
      expect(await collect(client)).toEqual([
        { type: 'briefing_error', code: 'rate_limited', retryable: true },
      ]);
    }
  );

  it.each([
    {
      name: 'unterminated tool frame',
      chunks: ['data: {"type":"tool_result","payload":"', 'x'.repeat(80)],
    },
    {
      name: 'completed unknown frame across chunks',
      chunks: ['data: {"type":"future_unknown","payload":"', `${'x'.repeat(80)}"}\n\n`],
    },
  ])('bounds the parser buffer for an oversized $name', async ({ chunks }) => {
    let upstreamSignal: AbortSignal | null | undefined;
    const client = new BtServantClient({
      ...options,
      maxFrameBytes: 64,
      fetch: async (_url, init) => {
        upstreamSignal = init?.signal;
        return response(chunks);
      },
    });
    expect(await collect(client)).toEqual([
      { type: 'briefing_error', code: 'malformed_upstream_response', retryable: false },
    ]);
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('enforces connection, valid-event idle, and total budgets', async () => {
    vi.useFakeTimers();
    const neverConnects = new BtServantClient({
      ...options,
      connectMs: 10,
      totalMs: 100,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('abort', 'AbortError'))
          );
        }),
    });
    const connecting = collect(neverConnects);
    await vi.advanceTimersByTimeAsync(11);
    await expect(connecting).resolves.toEqual([
      { type: 'briefing_error', code: 'timed_out', retryable: true },
    ]);

    const hangingResponse = (signal?: AbortSignal | null) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener('abort', () => controller.error(new DOMException('abort')));
          },
        })
      );
    const idles = new BtServantClient({
      ...options,
      idleMs: 10,
      totalMs: 100,
      fetch: async (_url, init) => hangingResponse(init?.signal),
    });
    const idling = collect(idles);
    await vi.advanceTimersByTimeAsync(11);
    await expect(idling).resolves.toEqual([
      { type: 'briefing_error', code: 'timed_out', retryable: true },
    ]);

    const totals = new BtServantClient({
      ...options,
      idleMs: 100,
      totalMs: 10,
      fetch: async (_url, init) => hangingResponse(init?.signal),
    });
    const totaling = collect(totals);
    await vi.advanceTimersByTimeAsync(11);
    await expect(totaling).resolves.toEqual([
      { type: 'briefing_error', code: 'timed_out', retryable: true },
    ]);
  });

  it('treats status/progress as valid idle activity while total remains bounded', async () => {
    vi.useFakeTimers();
    const client = new BtServantClient({
      ...options,
      idleMs: 50,
      totalMs: 500,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              setTimeout(
                () => controller.enqueue(encoder.encode('data: {"type":"status"}\n\n')),
                40
              );
              setTimeout(
                () =>
                  controller.enqueue(encoder.encode('data: {"type":"progress","text":"ok"}\n\n')),
                80
              );
              setTimeout(() => {
                controller.enqueue(
                  encoder.encode('data: {"type":"complete","response":{"responses":["ok"]}}\n\n')
                );
                controller.close();
              }, 120);
            },
          })
        ),
    });
    const result = collect(client);
    await vi.advanceTimersByTimeAsync(121);
    await expect(result).resolves.toEqual([
      { type: 'briefing_delta', delta: 'ok' },
      { type: 'briefing_complete', markdown: 'ok' },
    ]);
  });

  it('does not let unknown events extend the valid-event idle budget', async () => {
    vi.useFakeTimers();
    const client = new BtServantClient({
      ...options,
      idleMs: 50,
      totalMs: 500,
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(
                () =>
                  controller.enqueue(
                    new TextEncoder().encode('data: {"type":"future_unknown"}\n\n')
                  ),
                40
              );
              init?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('abort'))
              );
            },
          })
        ),
    });
    const result = collect(client);
    await vi.advanceTimersByTimeAsync(51);
    await expect(result).resolves.toEqual([
      { type: 'briefing_error', code: 'timed_out', retryable: true },
    ]);
  });

  it('accepts repeated JSON keepalives as idle activity while total timeout still wins', async () => {
    vi.useFakeTimers();
    const client = new BtServantClient({
      ...options,
      idleMs: 50,
      totalMs: 110,
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              setTimeout(
                () => controller.enqueue(encoder.encode('data: {"type":"keepalive"}\n\n')),
                40
              );
              setTimeout(
                () => controller.enqueue(encoder.encode('data: {"type":"keepalive"}\n\n')),
                80
              );
              init?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('abort'))
              );
            },
          })
        ),
    });
    const result = collect(client);
    await vi.advanceTimersByTimeAsync(111);
    await expect(result).resolves.toEqual([
      { type: 'briefing_error', code: 'timed_out', retryable: true },
    ]);
  });

  it('does not call BT for a pre-aborted subscriber', async () => {
    const subscriber = new AbortController();
    subscriber.abort();
    const fetcher = vi.fn(async () => response([]));
    const client = new BtServantClient({ ...options, fetch: fetcher });
    const events = [];
    for await (const event of client.stream(
      { userId: 'fluent_1', message: 'x', responseLanguageHint: 'en' },
      subscriber.signal
    ))
      events.push(event);
    expect(events).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('suppresses buffered frames after cancellation and replaces buffered frames after timeout', async () => {
    const body =
      'data: {"type":"progress","text":"first"}\n\ndata: {"type":"progress","text":"late"}\n\ndata: {"type":"complete","response":{"responses":["firstlate"]}}\n\n';
    const subscriber = new AbortController();
    const cancelledClient = new BtServantClient({
      ...options,
      fetch: async () => response([body]),
    });
    const cancelled = cancelledClient.stream(
      { userId: 'fluent_1', message: 'x', responseLanguageHint: 'en' },
      subscriber.signal
    );
    await expect(cancelled.next()).resolves.toEqual({
      done: false,
      value: { type: 'briefing_delta', delta: 'first' },
    });
    subscriber.abort();
    await expect(cancelled.next()).resolves.toEqual({ done: true, value: undefined });

    vi.useFakeTimers();
    const timedClient = new BtServantClient({
      ...options,
      totalMs: 10,
      idleMs: 100,
      fetch: async () => response([body]),
    });
    const timed = timedClient.stream({
      userId: 'fluent_1',
      message: 'x',
      responseLanguageHint: 'en',
    });
    await expect(timed.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'briefing_delta', delta: 'first' },
    });
    await vi.advanceTimersByTimeAsync(11);
    await expect(timed.next()).resolves.toEqual({
      done: false,
      value: { type: 'briefing_error', code: 'timed_out', retryable: true },
    });
    await expect(timed.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('suppresses provider deltas after subscriber cancellation', async () => {
    const subscriber = new AbortController();
    let provider: ReadableStreamDefaultController<Uint8Array>;
    const client = new BtServantClient({
      ...options,
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              provider = controller;
              init?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('abort'))
              );
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"progress","text":"first"}\n\n')
              );
            },
          })
        ),
    });
    const events: unknown[] = [];
    const reading = (async () => {
      for await (const event of client.stream(
        { userId: 'fluent_1', message: 'x', responseLanguageHint: 'en' },
        subscriber.signal
      ))
        events.push(event);
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    subscriber.abort();
    await reading;
    expect(events).toEqual([{ type: 'briefing_delta', delta: 'first' }]);
    expect(() =>
      provider!.enqueue(new TextEncoder().encode('data: {"type":"progress","text":"late"}\n\n'))
    ).toThrow();
  });
});
