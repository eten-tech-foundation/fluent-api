import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import env from '@/env';

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
import { assistantTurnEventSchema, briefingIntegrityMetadataSchema } from './assistant.turn.types';
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

it('replaces only the current turn, signs every state and caches only the authoritative final', async () => {
  source(async function* () {
    yield { type: 'briefing_delta', delta: 'provisional' };
    yield { type: 'briefing_replace', markdown: '' };
    yield { type: 'briefing_delta', delta: 'final' };
    yield { type: 'briefing_complete', markdown: 'corrected final' };
  });
  const body = { ...request(), dont_cache: false };
  const result = await events(await post(body));
  expect(result.map((event) => event.type)).toEqual([
    'turn_started',
    'turn_delta',
    'turn_replace',
    'turn_delta',
    'turn_replace',
    'turn_complete',
  ]);
  const receipts = new receiptsModule.TurnReceipts(key, user.id, context());
  const verified = verifyTurnTranscript(receipts, context(), body, 5);
  expect(verified.ok).toBe(true);
  if (!verified.ok) return;
  let markdown = '';
  for (const event of result) {
    if (event.type === 'turn_delta') markdown += event.delta;
    if (event.type === 'turn_replace') markdown = event.markdown;
    if ('receipt' in event)
      expect(
        receipts.verifyPrefix(
          {
            markdown,
            sequence: event.sequence,
            complete: event.type === 'turn_complete',
            receipt: event.receipt,
          },
          verified.binding
        )
      ).toBe(true);
  }
  expect(cache.publishCompletedArtifact).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ markdown: 'corrected final' }),
    expect.any(AbortSignal)
  );
  vi.mocked(cache.findCompletedArtifact).mockResolvedValue({
    cacheKey: 'fixture',
    markdown: 'corrected final',
    cacheEpoch: '1',
    outputContractVersion: 'fluent-widgets-v1',
  });
  const replay = await events(await post(body));
  expect(replay.filter((event) => event.type === 'turn_delta').map((event) => event.delta)).toEqual(
    ['corrected final']
  );
});

it('delivers signed briefing replacements and publishes only final cache text', async () => {
  source(async function* () {
    yield { type: 'briefing_delta', delta: 'discarded briefing' };
    yield { type: 'briefing_replace', markdown: '' };
    yield { type: 'briefing_delta', delta: 'final briefing' };
    yield { type: 'briefing_complete', markdown: 'final briefing' };
  });
  const body = request();
  const response = await assistantRouteMocks.server.request('/projects/7/assistant/briefing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bookCode: body.bookCode,
      chapter: body.chapter,
      activeVerse: body.activeVerse,
      outputLanguage: body.outputLanguage,
    }),
  });
  const wire = await response.text();
  // All replacement receipts have already been issued when this older visible snapshot arrives.
  const oldSnapshot = wire.split('\n').filter((line) => line.startsWith('data: '))[1];
  const oldMetadata = briefingIntegrityMetadataSchema
    .strip()
    .parse(JSON.parse(oldSnapshot.slice(6)));
  const continuation = await events(
    await post({
      ...body,
      contextReceipt: oldMetadata.contextReceipt,
      briefing: { markdown: 'discarded briefing', ...oldMetadata.prefix },
    })
  );
  expect(continuation[0].type).toBe('turn_started');
  expect(wire).toContain('event: briefing_replace');
  expect(wire).toContain('"markdown":"","protocol":"fluent-turn-v1"');
  expect(cache.publishCompletedArtifact).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ markdown: 'final briefing' }),
    expect.any(AbortSignal)
  );
});
