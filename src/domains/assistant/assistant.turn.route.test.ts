import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import env from '@/env';

import type { BriefingEvent } from './assistant.client';
import type { BtClientFactory, MockBtInstance } from './assistant.route.test-fixtures';

import * as receiptsModule from './assistant.receipts';
import {
  assistantRouteMocks,
  authenticate,
  config,
  resetAssistantRouteTestFixture,
  user,
  validBody,
} from './assistant.route.test-fixtures';
import { verifyTurnTranscript } from './assistant.transcript';
import {
  turnRouteContext as context,
  turnRouteKey as key,
  turnRoutePassage as passage,
  turnRouteRequest as request,
} from './assistant.turn.route.fixtures';
import { assistantTurnEventSchema } from './assistant.turn.types';
import * as cache from './cache/assistant-cache.repository';

const { BtServantClient } = assistantRouteMocks;

function post(body: unknown, signal?: AbortSignal) {
  return assistantRouteMocks.server.request('/projects/7/assistant/turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}
async function events(response: Response) {
  expect(response.status).toBe(200);
  const wire = await response.text();
  const ids = wire
    .split('\n')
    .filter((line) => line.startsWith('id: '))
    .map((line) => Number(line.slice(4)));
  expect(ids).toEqual(ids.map((_, index) => index + 1));
  return wire
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => assistantTurnEventSchema.parse(JSON.parse(line.slice(6))));
}
function source(generate: () => AsyncGenerator<BriefingEvent>) {
  vi.mocked(BtServantClient).mockImplementation(function (this: MockBtInstance) {
    this.stream = vi.fn(generate);
  } as unknown as BtClientFactory);
}
beforeEach(async () => {
  await resetAssistantRouteTestFixture();
  authenticate();
  vi.spyOn(receiptsModule, 'loadReceiptKey').mockReturnValue(key);
  vi.mocked(assistantRouteMocks.resolveCanonicalPassage).mockResolvedValue(passage);
  vi.mocked(cache.findCompletedArtifact).mockResolvedValue(null);
  vi.mocked(cache.publishCompletedArtifact).mockResolvedValue(true);
  env.ASSISTANT_HISTORY_WINDOW = undefined;
});
afterEach(() => vi.restoreAllMocks());

describe('POST guarded turns', () => {
  it('returns the same sanitized non-retryable configuration failure on every transport', async () => {
    const body = request();
    const saved = env.ASSISTANT_LANGUAGES_JSON;
    env.ASSISTANT_LANGUAGES_JSON = '{private-configuration-value';
    vi.mocked(assistantRouteMocks.loadAssistantConfig).mockReturnValue(null);
    try {
      const responses = [
        await assistantRouteMocks.server.request('/projects/7/assistant/languages'),
        await assistantRouteMocks.server.request('/projects/7/assistant/briefing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(validBody),
        }),
        await post(body),
      ];
      for (const response of responses) {
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: 'invalid_configuration', retryable: false });
      }
      expect(assistantRouteMocks.logger.warn).toHaveBeenCalledExactlyOnceWith(
        { reason: 'The value must be valid JSON.' },
        'Invalid ASSISTANT_LANGUAGES_JSON configuration'
      );
      expect(JSON.stringify(vi.mocked(assistantRouteMocks.logger.warn).mock.calls)).not.toContain(
        'private-configuration-value'
      );
      expect(BtServantClient).not.toHaveBeenCalled();
    } finally {
      env.ASSISTANT_LANGUAGES_JSON = saved;
    }
  });

  it('checks project guards before source, receipts or cache', async () => {
    authenticate(false);
    expect((await post(request())).status).toBe(404);
    expect(assistantRouteMocks.resolveCanonicalPassage).not.toHaveBeenCalled();
    expect(receiptsModule.loadReceiptKey).not.toHaveBeenCalled();
    expect(cache.findCompletedArtifact).not.toHaveBeenCalled();
  });
  it.each([' ', '"x":1,'])(
    'counts raw overhead before parsing/signing/provider (%s)',
    async (overhead) => {
      const body = overhead === ' ' ? ' '.repeat(524289) : `{${overhead.repeat(90000)}"x":1}`;
      expect((await post(body)).status).toBe(413);
      expect(receiptsModule.loadReceiptKey).not.toHaveBeenCalled();
      expect(assistantRouteMocks.resolveCanonicalPassage).not.toHaveBeenCalled();
      expect(BtServantClient).not.toHaveBeenCalled();
    }
  );
  it('normalizes invalid JSON and rejects client window selection', async () => {
    expect((await post('{')).status).toBe(400);
    expect((await post({ ...request(), historyWindow: 50 })).status).toBe(400);
  });
  it.each(['tamper', 'source', 'actor'])(
    'returns context_changed before start/cache (%s)',
    async (mode) => {
      const body = request();
      if (mode === 'tamper') body.briefing.markdown += '!';
      if (mode === 'source')
        vi.mocked(assistantRouteMocks.resolveCanonicalPassage).mockResolvedValue({
          ...passage,
          verses: [{ ...passage.verses[0], text: 'changed' }],
        });
      if (mode === 'actor') user.id++;
      expect(await events(await post(body))).toEqual([
        { protocol: 'fluent-turn-v1', type: 'context_changed' },
      ]);
      expect(cache.findCompletedArtifact).not.toHaveBeenCalled();
      expect(BtServantClient).not.toHaveBeenCalled();
    }
  );
  it.each(['key', 'provider', 'window'])('fails closed with missing/invalid %s', async (mode) => {
    if (mode === 'key') vi.mocked(receiptsModule.loadReceiptKey).mockReturnValue(null);
    if (mode === 'provider')
      vi.mocked(assistantRouteMocks.loadAssistantConfig).mockReturnValue(null);
    if (mode === 'window') env.ASSISTANT_HISTORY_WINDOW = '0';
    expect((await post(request())).status).toBe(503);
    expect(cache.findCompletedArtifact).not.toHaveBeenCalled();
  });
  it('delivers exact verified projection, stable actor identity and verifiable completion', async () => {
    const body = request();
    const result = await events(await post(body));
    expect(result.map((e) => e.type)).toEqual(['turn_started', 'turn_delta', 'turn_complete']);
    const instance = vi.mocked(BtServantClient).mock.results[0].value as MockBtInstance;
    const receipts = new receiptsModule.TurnReceipts(key, user.id, context());
    const verified = verifyTurnTranscript(receipts, context(), body, 5);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(instance.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        message: verified.projection.generationInput.message,
        history: [],
        userId: 'fluent_17',
      }),
      expect.any(AbortSignal)
    );
    const complete = result.at(-1)!;
    if (complete.type !== 'turn_complete') return;
    expect(
      receipts.verifyPrefix(
        {
          markdown: 'brief',
          sequence: complete.sequence,
          complete: true,
          receipt: complete.receipt,
        },
        verified.binding
      )
    ).toBe(true);
    expect(cache.publishCompletedArtifact).not.toHaveBeenCalled();
  });
  it.each([undefined, true])(
    'default/true reads hit with fresh actor receipts (%s)',
    async (dont_cache) => {
      vi.mocked(cache.findCompletedArtifact).mockResolvedValue({
        cacheKey: 'a'.repeat(64),
        markdown: 'cached',
        cacheEpoch: '1',
        outputContractVersion: 'fluent-widgets-v1',
      });
      const first = await events(await post({ ...request(), dont_cache }));
      const firstKey = vi.mocked(cache.findCompletedArtifact).mock.calls[0][0];
      user.id++;
      const second = await events(await post({ ...request(), dont_cache }));
      expect(vi.mocked(cache.findCompletedArtifact).mock.calls[1][0]).toBe(firstKey);
      expect(second.at(-1)).not.toEqual(first.at(-1));
      expect(BtServantClient).not.toHaveBeenCalled();
    }
  );
  it('cacheable publishes only completed markdown and private misses stay independent', async () => {
    await events(await post({ ...request(), dont_cache: false }));
    expect(cache.publishCompletedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        markdown: 'brief',
        cacheEpoch: '1',
        outputContractVersion: 'fluent-widgets-v1',
      }),
      expect.any(AbortSignal)
    );
    await events(await post(request()));
    expect(BtServantClient).toHaveBeenCalledTimes(2);
    expect(cache.publishCompletedArtifact).toHaveBeenCalledTimes(1);
  });
  it('isolates shared turn prompts from hostile catalogs and uses them only on private misses', async () => {
    const hostile = [{ type: 'hostile', purpose: 'HOSTILE PURPOSE', template: 'HOSTILE TEMPLATE' }];
    await events(await post({ ...request(), actions: hostile, dont_cache: false }));
    await events(await post({ ...request(), actions: hostile, dont_cache: true }));
    const shared = vi.mocked(BtServantClient).mock.instances[0] as unknown as MockBtInstance;
    const privateClient = vi.mocked(BtServantClient).mock.instances[1] as unknown as MockBtInstance;
    expect(shared.stream.mock.calls[0][0].message).toContain('suggested_question');
    expect(shared.stream.mock.calls[0][0].message).not.toContain('HOSTILE PURPOSE');
    expect(privateClient.stream.mock.calls[0][0].message).toContain('HOSTILE PURPOSE');
  });
  it('does not share arbitrary text merely labeled as a suggested question', async () => {
    const body = request();
    body.dont_cache = false;
    body.submission.input.text = 'Client-invented question';
    await events(await post(body));
    expect(cache.findCompletedArtifact).not.toHaveBeenCalled();
    expect(cache.publishCompletedArtifact).not.toHaveBeenCalled();
    expect(BtServantClient).toHaveBeenCalledTimes(1);
  });
  it.each(['limit', 'eof', 'throw', 'rate', 'timeout'])(
    'never publishes failed/partial %s output',
    async (mode) => {
      source(async function* () {
        yield {
          type: 'briefing_delta',
          delta: mode === 'limit' ? 'x'.repeat(8 * 1024 * 1024 + 1) : 'partial',
        };
        if (mode === 'throw') throw new Error('private details');
        if (mode === 'timeout')
          yield { type: 'briefing_error', code: 'timed_out', retryable: true };
        if (mode === 'rate')
          yield {
            type: 'briefing_error',
            code: 'rate_limited',
            retryable: true,
            retryAfter: 999999,
          };
      });
      const result = await events(await post({ ...request(), dont_cache: false }));
      expect(result.at(-1)?.type).toBe('turn_error');
      expect(cache.publishCompletedArtifact).not.toHaveBeenCalled();
      if (mode === 'limit') expect(result.some((e) => e.type === 'turn_delta')).toBe(false);
      if (mode === 'rate')
        expect(result.at(-1)).toMatchObject({ code: 'rate_limited', retryAfter: 86400 });
    }
  );
  it('database failures preserve private completion', async () => {
    vi.mocked(cache.findCompletedArtifact).mockRejectedValue(new Error('db'));
    expect((await events(await post(request()))).at(-1)?.type).toBe('turn_complete');
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('cacheable producer survives interruption; private branch does not join it', async () => {
  const gate = deferred();
  source(async function* () {
    yield { type: 'briefing_delta', delta: 'partial' };
    await gate.promise;
    yield { type: 'briefing_delta', delta: ' finished' };
    yield { type: 'briefing_complete', markdown: 'partial finished' };
  });
  const controller = new AbortController();
  const first = await post({ ...request(), dont_cache: false }, controller.signal);
  const firstRead = first.text();
  await vi.waitFor(() => expect(BtServantClient).toHaveBeenCalledTimes(1));
  controller.abort();
  const joined = await post({ ...request(), dont_cache: false });
  const joinedRead = events(joined);
  const busy = await post(request());
  expect(busy.status).toBe(429);
  expect(await busy.json()).toEqual({ code: 'generation_busy', retryable: true, retryAfter: 1 });
  expect(BtServantClient).toHaveBeenCalledTimes(1);
  gate.resolve();
  await firstRead;
  expect((await joinedRead).at(-1)?.type).toBe('turn_complete');
  expect((await events(await post(request()))).at(-1)?.type).toBe('turn_complete');
  expect(cache.publishCompletedArtifact).toHaveBeenCalledTimes(1);
});

it('retains completion during publication and an overlapping stale cache miss', async () => {
  const lookup = deferred();
  const writing = deferred();
  let reads = 0;
  vi.mocked(cache.findCompletedArtifact).mockImplementation(async () => {
    if (++reads === 1) await lookup.promise;
    return null;
  });
  vi.mocked(cache.publishCompletedArtifact).mockImplementation(async () => {
    await writing.promise;
    return true;
  });
  const stale = post({ ...request(), dont_cache: false });
  await vi.waitFor(() => expect(reads).toBe(1));
  const owner = await post({ ...request(), dont_cache: false });
  const ownerRead = events(owner);
  await vi.waitFor(() => expect(cache.publishCompletedArtifact).toHaveBeenCalledTimes(1));
  const joined = events(await post({ ...request(), dont_cache: false }));
  writing.resolve();
  await ownerRead;
  lookup.resolve();
  expect((await events(await stale)).at(-1)?.type).toBe('turn_complete');
  expect((await joined).at(-1)?.type).toBe('turn_complete');
  expect(BtServantClient).toHaveBeenCalledTimes(1);
});

it('shutdown stops shared production and rejects subsequent shared installs', async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(BtServantClient).mockImplementation(function (this: MockBtInstance) {
    this.stream = vi.fn(async function* (_request: unknown, upstream: AbortSignal) {
      signal = upstream;
      yield { type: 'briefing_delta', delta: 'partial' };
      await new Promise<void>((resolve) =>
        upstream.addEventListener('abort', () => resolve(), { once: true })
      );
    });
  } as unknown as BtClientFactory);
  const response = await post({ ...request(), dont_cache: false });
  const read = events(response);
  await vi.waitFor(() => expect(signal).toBeDefined());
  await assistantRouteMocks.shutdownInFlightGenerations();
  expect(signal?.aborted).toBe(true);
  expect((await read).at(-1)?.type).toBe('turn_error');
  expect((await events(await post({ ...request(), dont_cache: false }))).at(-1)?.type).toBe(
    'turn_error'
  );
  expect(cache.publishCompletedArtifact).not.toHaveBeenCalled();
});

it('coalesces tiny deltas into bounded atomic signatures', async () => {
  const sign = vi.spyOn(receiptsModule.TurnReceipts.prototype, 'prefix');
  source(async function* () {
    for (let i = 0; i < 15000; i++) yield { type: 'briefing_delta', delta: 'x' };
    yield { type: 'briefing_complete', markdown: 'x'.repeat(15000) };
  });
  const body = request();
  sign.mockClear();
  const result = await events(await post(body));
  expect(sign.mock.calls.length).toBeLessThanOrEqual(61);
  expect(
    result
      .filter((e) => e.type === 'turn_delta')
      .map((e) => e.delta)
      .join('')
  ).toBe('x'.repeat(15000));
  expect(result.at(-1)?.type).toBe('turn_complete');
});

it('cache identity ignores execution and duplicate policy labels but rejects claimed arbitrary suggestions', async () => {
  await events(await post(request()));
  const body = request();
  body.submission.turnId = 'other';
  body.submission.attemptId = 'other';
  body.submission.input.origin = 'suggested_question';
  await events(await post(body));
  const first = vi.mocked(cache.findCompletedArtifact).mock.calls[0][0];
  expect(vi.mocked(cache.findCompletedArtifact).mock.calls[1][0]).toBe(first);
  body.submission.input.text += ' ';
  await events(await post(body));
  expect(cache.findCompletedArtifact).toHaveBeenCalledTimes(2);
  const old = config.resourcePolicyVersion;
  try {
    config.resourcePolicyVersion = 'changed';
    await events(await post(request()));
    expect(vi.mocked(cache.findCompletedArtifact).mock.calls[2][0]).toBe(first);
  } finally {
    config.resourcePolicyVersion = old;
  }
});

it('verifies all history before retaining the configured newest five pairs', async () => {
  const body = request();
  const receipts = new receiptsModule.TurnReceipts(key, user.id, context());
  for (let index = 0; index < 7; index++) {
    body.submission = {
      kind: 'new',
      turnId: `turn-${index}`,
      attemptId: `attempt-${index}`,
      input: { text: `Question ${index}`, origin: 'typed' },
    };
    const verified = verifyTurnTranscript(receipts, context(), body, 5);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const prefix = { markdown: `Answer ${index}`, sequence: 1, complete: true };
    body.turns.push({
      turnId: body.submission.turnId,
      input: body.submission.input,
      selectedAttemptId: body.submission.attemptId,
      attempts: [
        {
          attemptId: body.submission.attemptId,
          operationId: `operation-${index}`,
          state: 'complete',
          prefix: { ...prefix, receipt: receipts.prefix(verified.binding, prefix) },
        },
      ],
    });
  }
  body.submission = {
    kind: 'new',
    turnId: 'latest',
    attemptId: 'latest',
    input: { text: 'Latest?', origin: 'typed' },
  };
  const result = await events(await post(body));
  expect(result[0]).toMatchObject({
    projection: { historyWindow: 5, omittedTurnIds: ['turn-0', 'turn-1'] },
  });
  const instance = vi.mocked(BtServantClient).mock.results[0].value as MockBtInstance;
  expect(instance.stream).toHaveBeenCalledWith(
    expect.objectContaining({
      history: expect.arrayContaining([
        expect.objectContaining({ assistant_response: 'Answer 2' }),
      ]),
    }),
    expect.any(AbortSignal)
  );
  expect(instance.stream.mock.calls[0][0].history).toHaveLength(5);
  vi.mocked(cache.findCompletedArtifact).mockClear();
  body.turns[0].attempts[0].prefix!.markdown += 'tampered';
  expect(await events(await post(body))).toEqual([
    { protocol: 'fluent-turn-v1', type: 'context_changed' },
  ]);
  expect(cache.findCompletedArtifact).not.toHaveBeenCalled();
});

it('normalizes JSON syntax failures without logging submitted content', async () => {
  const response = await post('{"private_question":');
  expect(await response.json()).toEqual({ code: 'invalid_request', retryable: false });
  expect(JSON.stringify(vi.mocked(assistantRouteMocks.logger.info).mock.calls)).not.toContain(
    'private_question'
  );
});

it('failed artifact publication still completes for every subscriber', async () => {
  vi.mocked(cache.publishCompletedArtifact).mockRejectedValue(new Error('database unavailable'));
  expect((await events(await post({ ...request(), dont_cache: false }))).at(-1)?.type).toBe(
    'turn_complete'
  );
  expect(assistantRouteMocks.logger.warn).toHaveBeenCalled();
});

it('a disconnected private miss never publishes its partial answer', async () => {
  const gate = deferred();
  source(async function* () {
    yield { type: 'briefing_delta', delta: 'partial' };
    await gate.promise;
    yield { type: 'briefing_complete', markdown: 'partial' };
  });
  const controller = new AbortController();
  const response = await post(request(), controller.signal);
  const read = response.text();
  controller.abort();
  gate.resolve();
  const wire = await read;
  expect(wire).not.toContain('turn_complete');
  expect(cache.publishCompletedArtifact).not.toHaveBeenCalled();
});

it('requires authentication and endpoint permission before admission work', async () => {
  const body = request();
  await resetAssistantRouteTestFixture();
  expect((await post(body)).status).toBe(401);
  authenticate();
  user.grants = [];
  expect((await post(body)).status).toBe(403);
  expect(receiptsModule.loadReceiptKey).not.toHaveBeenCalled();
  expect(cache.findCompletedArtifact).not.toHaveBeenCalled();
});

it('rejects unsupported languages and unresolved mandatory context before cache access', async () => {
  expect((await post({ ...request(), outputLanguage: 'xx' })).status).toBe(400);
  vi.mocked(assistantRouteMocks.resolveCanonicalPassage).mockResolvedValue({
    ...passage,
    integritySource: undefined,
  });
  expect((await post(request())).status).toBe(413);
  expect(cache.findCompletedArtifact).not.toHaveBeenCalled();
});
