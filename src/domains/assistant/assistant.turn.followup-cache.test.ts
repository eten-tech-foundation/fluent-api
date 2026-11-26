import { beforeEach, expect, it, vi } from 'vitest';

import type { BriefingEvent } from './assistant.client';
import type { BtClientFactory, MockBtInstance } from './assistant.route.test-fixtures';

import * as receiptsModule from './assistant.receipts';
import {
  assistantRouteMocks,
  authenticate,
  resetAssistantRouteTestFixture,
  user,
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
function laterRequest(answer = 'Earlier answer') {
  const body = request();
  body.submission.input = { text: 'Typed earlier question', origin: 'typed' };
  const receipts = new receiptsModule.TurnReceipts(key, user.id, context());
  const verified = verifyTurnTranscript(receipts, context(), body, 5);
  if (!verified.ok) throw new Error('Invalid fixture');
  const prefix = { markdown: answer, sequence: 1, complete: true };
  body.turns.push({
    turnId: body.submission.turnId,
    input: body.submission.input,
    selectedAttemptId: body.submission.attemptId,
    attempts: [
      {
        attemptId: body.submission.attemptId,
        operationId: 'earlier-operation',
        state: 'complete',
        prefix: { ...prefix, receipt: receipts.prefix(verified.binding, prefix) },
      },
    ],
  });
  body.submission = {
    kind: 'new',
    turnId: 'later',
    attemptId: 'later-attempt',
    input: { text: 'Later suggestion?', origin: 'suggested_question' },
  };
  body.dont_cache = false;
  return body;
}
function post(body: unknown) {
  return assistantRouteMocks.server.request('/projects/7/assistant/turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function events(response: Response) {
  expect(response.status).toBe(200);
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => assistantTurnEventSchema.parse(JSON.parse(line.slice(6))));
}
beforeEach(async () => {
  await resetAssistantRouteTestFixture();
  authenticate();
  vi.spyOn(receiptsModule, 'loadReceiptKey').mockReturnValue(key);
  vi.mocked(assistantRouteMocks.resolveCanonicalPassage).mockResolvedValue(passage);
  vi.mocked(cache.findCompletedArtifact).mockResolvedValue(null);
  vi.mocked(cache.publishCompletedArtifact).mockResolvedValue(true);
});
it.each([false, true])(
  'reads later exact artifacts with dont_cache %s after typed ancestry',
  async (dont_cache) => {
    await events(await post(laterRequest()));
    const published = vi.mocked(cache.publishCompletedArtifact).mock.calls[0][0];
    vi.mocked(cache.findCompletedArtifact).mockResolvedValue(published);
    const replay = await events(await post({ ...laterRequest(), dont_cache }));
    expect(replay.at(-1)?.type).toBe('turn_complete');
    expect(BtServantClient).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cache.findCompletedArtifact).mock.calls[1][0]).toBe(published.cacheKey);
    vi.mocked(cache.findCompletedArtifact).mockResolvedValue(null);
    await events(await post(laterRequest('Different earlier answer')));
    expect(vi.mocked(cache.findCompletedArtifact).mock.calls[2][0]).not.toBe(published.cacheKey);
    expect(cache.publishCompletedArtifact).toHaveBeenCalledTimes(2);
  }
);
it('late same-key later-turn joiners replay retained partial events with one producer', async () => {
  const gate = Promise.withResolvers<void>();
  const partial = Promise.withResolvers<void>();
  vi.mocked(BtServantClient).mockImplementation(function (this: MockBtInstance) {
    this.stream = vi.fn(async function* (): AsyncGenerator<BriefingEvent> {
      yield { type: 'briefing_delta', delta: 'partial' };
      partial.resolve();
      await gate.promise;
      yield { type: 'briefing_delta', delta: ' finished' };
      yield { type: 'briefing_complete', markdown: 'partial finished' };
    });
  } as unknown as BtClientFactory);
  const first = events(await post(laterRequest()));
  await partial.promise;
  const joined = events(await post(laterRequest()));
  expect(BtServantClient).toHaveBeenCalledTimes(1);
  expect((await post({ ...laterRequest(), dont_cache: true })).status).toBe(429);
  gate.resolve();
  await first;
  const result = await joined;
  expect(result.filter((event) => event.type === 'turn_delta').map((event) => event.delta)).toEqual(
    ['partial', ' finished']
  );
  expect(result.at(-1)?.type).toBe('turn_complete');
  expect(cache.publishCompletedArtifact).toHaveBeenCalledTimes(1);
});
