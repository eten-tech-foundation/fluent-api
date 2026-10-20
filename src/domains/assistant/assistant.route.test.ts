import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BtClientFactory, MockBtInstance } from './assistant.route.test-fixtures';

import {
  assistantRouteMocks,
  authenticate,
  post,
  resetAssistantRouteTestFixture,
  user,
  validBody,
} from './assistant.route.test-fixtures';

const {
  BtServantClient,
  findCompletedBriefing,
  logger,
  publishCompletedBriefing,
  shutdownInFlightBriefings,
} = assistantRouteMocks;

describe('assistant briefing route cache lifecycle', () => {
  beforeEach(async () => {
    await resetAssistantRouteTestFixture();
  });

  it('replays an exact completed-row hit without BT and marks only that completion as a hit', async () => {
    authenticate();
    vi.mocked(findCompletedBriefing).mockResolvedValueOnce({
      cacheKey: 'a'.repeat(64),
      markdown: 'cached briefing',
      operationVersion: 'briefing-v1',
      profileVersion: 'fluent-profile-v1',
      resourcePolicyVersion: 'fluent-resource-policy-v1',
      cacheEpoch: '1',
      outputContractVersion: 'fluent-widgets-v1',
      responseLanguageHint: 'en',
      resourceLanguage: 'en',
      sourceLanguageCode: 'eng',
    });

    const body = await (await post(validBody)).text();
    expect(body).toContain('event: briefing_started');
    expect(body).toContain('"delta":"cached briefing"');
    expect(body).toContain('"markdown":"cached briefing"');
    expect(body).toContain('"cacheHit":true');
    expect(BtServantClient).not.toHaveBeenCalled();
    expect(publishCompletedBriefing).not.toHaveBeenCalled();
  });

  it('runs ignore_cache privately and bypasses completed reads, joining, and writes', async () => {
    authenticate();
    const body = await (await post({ ...validBody, ignore_cache: true })).text();
    expect(body).toContain('"cacheHit":false');
    expect(findCompletedBriefing).not.toHaveBeenCalled();
    expect(publishCompletedBriefing).not.toHaveBeenCalled();
    const instance = vi.mocked(BtServantClient).mock.instances[0] as unknown as MockBtInstance;
    expect(instance.stream).toHaveBeenCalledWith(expect.any(Object), expect.any(AbortSignal));
  });

  it('aborts a private ignore_cache producer when its request disconnects', async () => {
    authenticate();
    let upstreamSignal!: AbortSignal;
    vi.mocked(BtServantClient).mockImplementationOnce(function (this: MockBtInstance) {
      this.stream = vi.fn(async function* (_request, signal: AbortSignal) {
        upstreamSignal = signal;
        yield { type: 'briefing_delta', delta: 'private' };
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      });
    } as unknown as BtClientFactory);
    const request = new AbortController();
    const response = await post({ ...validBody, ignore_cache: true }, { signal: request.signal });
    const reader = response.body!.getReader();
    await reader.read();
    request.abort();
    await vi.waitFor(() => expect(upstreamSignal.aborted).toBe(true));
    await reader.cancel();
    expect(publishCompletedBriefing).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const finished = vi
        .mocked(logger.info)
        .mock.calls.filter((call) => call[1] === 'Assistant briefing finished');
      expect(finished).toHaveLength(1);
      expect(finished[0][0]).toEqual(
        expect.objectContaining({ outcome: 'detached', durationMs: expect.any(Number) })
      );
    });
  });

  it('does not publish a failed or interrupted upstream result', async () => {
    authenticate();
    vi.mocked(BtServantClient).mockImplementationOnce(function (this: MockBtInstance) {
      this.stream = vi.fn(async function* () {
        yield { type: 'briefing_delta', delta: 'partial' };
        yield { type: 'briefing_error', code: 'timed_out', retryable: true };
      });
    } as unknown as BtClientFactory);

    const body = await (await post(validBody)).text();
    expect(body).toContain('"delta":"partial"');
    expect(body).toContain('"code":"timed_out"');
    expect(body).not.toContain('event: briefing_complete');
    expect(publishCompletedBriefing).not.toHaveBeenCalled();
  });

  it('treats the completed cache as disposable when its read or write fails', async () => {
    authenticate();
    vi.mocked(findCompletedBriefing).mockRejectedValueOnce(new Error('database unavailable'));
    vi.mocked(publishCompletedBriefing).mockRejectedValueOnce(new Error('database unavailable'));

    const body = await (await post(validBody)).text();
    expect(body).toContain('event: briefing_complete');
    expect(body).toContain('"markdown":"brief"');
    expect(body).toContain('"cacheHit":false');
  });

  it('degrades after a bounded repository read rejection', async () => {
    authenticate();
    vi.mocked(findCompletedBriefing).mockRejectedValueOnce(new Error('read timeout'));
    const body = await (await post(validBody)).text();
    expect(body).toContain('event: briefing_complete');
    expect(BtServantClient).toHaveBeenCalledTimes(1);
  });

  it('degrades after a cancelled repository write without losing valid BT output', async () => {
    authenticate();
    vi.mocked(publishCompletedBriefing).mockRejectedValueOnce(new Error('write timeout'));
    const body = await (await post(validBody)).text();
    expect(body).toContain('event: briefing_complete');
    expect(body).toContain('"cacheHit":false');
  });

  it.each([
    ['malformed', 'First paragraph.\n\nSecond paragraph.\n\n{{not-a-fluent-macro}}'],
    ['missing', 'First paragraph.\n\nSecond paragraph with no suggested questions.'],
  ])(
    'caches safe completed Markdown when suggested-question macros are %s',
    async (_kind, text) => {
      authenticate();
      vi.mocked(BtServantClient).mockImplementationOnce(function (this: MockBtInstance) {
        this.stream = vi.fn(async function* () {
          yield { type: 'briefing_delta', delta: text };
          yield { type: 'briefing_complete', markdown: text };
        });
      } as unknown as BtClientFactory);
      const body = await (await post(validBody)).text();
      expect(body).toContain('event: briefing_complete');
      expect(publishCompletedBriefing).toHaveBeenCalledWith(
        expect.objectContaining({ markdown: text }),
        expect.any(AbortSignal)
      );
    }
  );

  it('reuses one authorized semantic artifact across user and project identities', async () => {
    authenticate(true, 7);
    await (await post(validBody)).text();
    const firstKey = vi.mocked(findCompletedBriefing).mock.calls[0][0];
    const artifact = vi.mocked(publishCompletedBriefing).mock.calls[0][0];

    user.id = 29;
    authenticate(true, 8);
    vi.mocked(findCompletedBriefing).mockResolvedValueOnce(artifact);
    const body = await (await post(validBody, { projectId: 8 })).text();
    expect(vi.mocked(findCompletedBriefing).mock.calls[1][0]).toBe(firstKey);
    expect(body).toContain('"cacheHit":true');
    expect(BtServantClient).toHaveBeenCalledTimes(1);
  });

  it('never logs the semantic key, source passage, prompt, or completed artifact', async () => {
    authenticate();
    await (await post(validBody)).text();
    const cacheKey = vi.mocked(publishCompletedBriefing).mock.calls[0][0].cacheKey;
    const logs = JSON.stringify([
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ]);
    expect(logs).not.toContain(cacheKey);
    expect(logs).not.toContain('server source');
    expect(logs).not.toContain('Canonical Source');
    expect(logs).not.toContain('fluent_source_passage');
    expect(logs).not.toContain('"markdown"');
  });

  it('rechecks after concurrent database misses and starts one same-hash producer', async () => {
    authenticate();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let upstreamStarts = 0;
    vi.mocked(BtServantClient).mockImplementation(function (this: MockBtInstance) {
      this.stream = vi.fn(async function* () {
        upstreamStarts++;
        yield { type: 'briefing_delta', delta: 'shared' };
        await gate;
        yield { type: 'briefing_complete', markdown: 'shared' };
      });
    } as unknown as BtClientFactory);

    const responses = await Promise.all([post(validBody), post(validBody)]);
    await vi.waitFor(() => expect(upstreamStarts).toBe(1));
    release();
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.includes('"markdown":"shared"'))).toBe(true);
    expect(bodies.every((body) => body.includes('"cacheHit":false'))).toBe(true);
    expect(publishCompletedBriefing).toHaveBeenCalledTimes(1);
    const finished = vi
      .mocked(logger.info)
      .mock.calls.filter((call) => call[1] === 'Assistant briefing finished');
    expect(finished).toHaveLength(2);
    const outcomes = finished.map((call) => call[0] as unknown as Record<string, unknown>);
    expect(new Set(outcomes.map((entry) => entry.attemptId)).size).toBe(2);
    expect(outcomes.every((entry) => entry.outcome === 'briefing_complete')).toBe(true);
    expect(outcomes.every((entry) => Number.isFinite(entry.durationMs))).toBe(true);
  });

  it('lets the last subscriber detach while the shared producer completes and writes', async () => {
    authenticate();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let upstreamSignal!: AbortSignal;
    vi.mocked(BtServantClient).mockImplementationOnce(function (this: MockBtInstance) {
      this.stream = vi.fn(async function* (_request, signal: AbortSignal) {
        upstreamSignal = signal;
        yield { type: 'briefing_delta', delta: 'retained' };
        await gate;
        yield { type: 'briefing_complete', markdown: 'retained' };
      });
    } as unknown as BtClientFactory);
    const request = new AbortController();
    const response = await post(validBody, { signal: request.signal });
    await response.body!.getReader().read();
    request.abort();
    expect(upstreamSignal.aborted).toBe(false);
    release();
    await vi.waitFor(() => expect(publishCompletedBriefing).toHaveBeenCalledTimes(1));
    expect(upstreamSignal.aborted).toBe(false);
    await vi.waitFor(() => {
      const finished = vi
        .mocked(logger.info)
        .mock.calls.filter((call) => call[1] === 'Assistant briefing finished');
      expect(finished).toHaveLength(1);
      expect((finished[0][0] as unknown as Record<string, unknown>).outcome).toBe('detached');
    });
  });

  it('keeps one joined subscriber delivering when the other detaches', async () => {
    authenticate();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(BtServantClient).mockImplementation(function (this: MockBtInstance) {
      this.stream = vi.fn(async function* () {
        yield { type: 'briefing_delta', delta: 'joined' };
        await gate;
        yield { type: 'briefing_complete', markdown: 'joined' };
      });
    } as unknown as BtClientFactory);
    const detachedRequest = new AbortController();
    const [detached, remaining] = await Promise.all([
      post(validBody, { signal: detachedRequest.signal }),
      post(validBody),
    ]);
    await detached.body!.getReader().read();
    detachedRequest.abort();
    release();
    const body = await remaining.text();
    expect(body).toContain('"markdown":"joined"');
    expect(publishCompletedBriefing).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      const finished = vi
        .mocked(logger.info)
        .mock.calls.filter((call) => call[1] === 'Assistant briefing finished');
      expect(
        finished.map((call) => (call[0] as unknown as Record<string, unknown>).outcome).sort()
      ).toEqual(['briefing_complete', 'detached']);
    });
  });

  it('aborts and settles one terminal per attached subscriber on controlled shutdown', async () => {
    authenticate();
    let upstreamSignal!: AbortSignal;
    vi.mocked(BtServantClient).mockImplementation(function (this: MockBtInstance) {
      this.stream = vi.fn(async function* (_request, signal: AbortSignal) {
        upstreamSignal = signal;
        yield { type: 'briefing_delta', delta: 'partial' };
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      });
    } as unknown as BtClientFactory);
    const responses = await Promise.all([post(validBody), post(validBody)]);
    await vi.waitFor(() => expect(upstreamSignal).toBeInstanceOf(AbortSignal));
    await shutdownInFlightBriefings();

    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(upstreamSignal.aborted).toBe(true);
    expect(bodies.every((body) => body.match(/event: briefing_error/g)?.length === 1)).toBe(true);
    expect(publishCompletedBriefing).not.toHaveBeenCalled();
    const finished = vi
      .mocked(logger.info)
      .mock.calls.filter((call) => call[1] === 'Assistant briefing finished');
    expect(finished).toHaveLength(2);
  });

  it('keeps a valid BT completion authoritative when shutdown interrupts its cache write', async () => {
    authenticate();
    let writeSignal!: AbortSignal;
    let wouldPersist = false;
    vi.mocked(publishCompletedBriefing).mockImplementationOnce(async (_artifact, signal) => {
      writeSignal = signal!;
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('query cancelled')), {
          once: true,
        });
      });
      wouldPersist = true;
      return true;
    });

    const response = await post(validBody);
    await vi.waitFor(() => expect(writeSignal).toBeInstanceOf(AbortSignal));
    await shutdownInFlightBriefings();
    const body = await response.text();

    expect(writeSignal.aborted).toBe(true);
    expect(wouldPersist).toBe(false);
    expect(body).toContain('event: briefing_complete');
    expect(body).not.toContain('event: briefing_error');
  });

  it('joins a producer when a stale database snapshot returns after publication and removal', async () => {
    authenticate();
    let finishStaleRead!: (value: null) => void;
    const staleRead = new Promise<null>((resolve) => {
      finishStaleRead = resolve;
    });
    vi.mocked(findCompletedBriefing).mockReturnValueOnce(staleRead).mockResolvedValueOnce(null);

    const straddler = post(validBody);
    await vi.waitFor(() => expect(findCompletedBriefing).toHaveBeenCalledTimes(1));
    const producerResponse = await post(validBody);
    await producerResponse.text();
    expect(publishCompletedBriefing).toHaveBeenCalledTimes(1);

    finishStaleRead(null);
    const straddlerBody = await (await straddler).text();
    expect(straddlerBody).toContain('"markdown":"brief"');
    const upstreamCalls = vi
      .mocked(BtServantClient)
      .mock.instances.reduce(
        (total, instance) =>
          total + (instance as unknown as MockBtInstance).stream.mock.calls.length,
        0
      );
    expect(upstreamCalls).toBe(1);
  });

  it('retains the producer through completed-row publication and hands later callers to PostgreSQL', async () => {
    authenticate();
    let finishPublish!: () => void;
    const publishing = new Promise<boolean>((resolve) => {
      finishPublish = () => resolve(true);
    });
    vi.mocked(publishCompletedBriefing).mockReturnValueOnce(publishing);

    const first = await post(validBody);
    await vi.waitFor(() => expect(publishCompletedBriefing).toHaveBeenCalledTimes(1));
    const joinedDuringPublish = await post(validBody);
    expect(findCompletedBriefing).toHaveBeenCalledTimes(1);
    finishPublish();

    const joinedBodies = await Promise.all([first.text(), joinedDuringPublish.text()]);
    expect(joinedBodies.every((body) => body.includes('"cacheHit":false'))).toBe(true);
    const published = vi.mocked(publishCompletedBriefing).mock.calls[0][0];
    vi.mocked(findCompletedBriefing).mockResolvedValueOnce(published);

    const afterRemoval = await (await post(validBody)).text();
    expect(afterRemoval).toContain('"cacheHit":true');
    const upstreamCalls = vi
      .mocked(BtServantClient)
      .mock.instances.reduce(
        (total, instance) =>
          total + (instance as unknown as MockBtInstance).stream.mock.calls.length,
        0
      );
    expect(upstreamCalls).toBe(1);
  });
});
