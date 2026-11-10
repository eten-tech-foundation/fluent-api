import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { BriefingEvent } from './assistant.client';
import type { BtClientFactory, MockBtInstance } from './assistant.route.test-fixtures';

import * as receipts from './assistant.receipts';
import {
  assistantRouteMocks,
  authenticate,
  post,
  resetAssistantRouteTestFixture,
  validBody,
} from './assistant.route.test-fixtures';
import * as cache from './cache/assistant-cache.repository';

beforeEach(async () => {
  await resetAssistantRouteTestFixture();
  authenticate();
  vi.spyOn(receipts, 'loadReceiptKey').mockReturnValue(
    receipts.parseReceiptKey({
      ASSISTANT_RECEIPT_KEY_ID: 'test',
      ASSISTANT_RECEIPT_KEY_HEX: '02'.repeat(32),
    })
  );
  vi.mocked(assistantRouteMocks.resolveCanonicalPassage).mockResolvedValue({
    sourceBible: 'Source',
    sourceLanguageCode: 'eng',
    verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'source' }],
    integritySource: {
      organizationId: 1,
      sourceBibleId: 9,
      provider: 'dbl',
      externalId: null,
      pericopeSetId: 3,
      membership: { number: '12', section: null },
      members: [{ id: 1, chapter: 4, verse: 25 }],
    },
  });
  vi.mocked(cache.findCompletedArtifact).mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

it.each(['', ' \n\t '])(
  'rejects blank cold completions and old cached artifacts (%j)',
  async (markdown) => {
    const briefing = await post({ ...validBody, ignore_cache: true });
    const frames = (await briefing.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    const body = {
      ...validBody,
      protocol: 'fluent-turn-v1',
      grounding: 'configured',
      contextReceipt: frames[0].contextReceipt,
      briefing: { markdown: 'brief', ...frames.at(-1).prefix },
      turns: [],
      dont_cache: false,
      submission: {
        kind: 'new',
        turnId: 'turn',
        attemptId: 'attempt',
        input: { text: 'Why?', origin: 'typed' },
      },
    };
    vi.mocked(assistantRouteMocks.BtServantClient).mockImplementation(function (
      this: MockBtInstance
    ) {
      this.stream = vi.fn(async function* (): AsyncGenerator<BriefingEvent> {
        if (markdown) yield { type: 'briefing_delta', delta: markdown };
        yield { type: 'briefing_complete', markdown };
      });
    } as unknown as BtClientFactory);
    const turn = () =>
      assistantRouteMocks.server.request('/projects/7/assistant/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const cold = await turn();
    expect(await cold.text()).toContain('malformed_upstream_response');
    expect(cache.publishCompletedArtifact).not.toHaveBeenCalled();
    vi.mocked(cache.findCompletedArtifact).mockResolvedValue({
      cacheKey: 'a'.repeat(64),
      markdown,
      cacheEpoch: '1',
      outputContractVersion: 'fluent-turn-v1',
    });
    body.dont_cache = true;
    vi.mocked(assistantRouteMocks.BtServantClient).mockClear();
    const cached = await turn();
    const wire = await cached.text();
    expect(wire).toContain('malformed_upstream_response');
    expect(wire).not.toContain('turn_complete');
    expect(assistantRouteMocks.BtServantClient).toHaveBeenCalledTimes(1);
    expect(cache.publishCompletedArtifact).not.toHaveBeenCalled();
    vi.mocked(assistantRouteMocks.BtServantClient).mockImplementation(function (
      this: MockBtInstance
    ) {
      this.stream = vi.fn(async function* (): AsyncGenerator<BriefingEvent> {
        yield { type: 'briefing_delta', delta: 'recovered' };
        yield { type: 'briefing_complete', markdown: 'recovered' };
      });
    } as unknown as BtClientFactory);
    expect(await (await turn()).text()).toContain('event: turn_complete');
    expect(cache.publishCompletedArtifact).not.toHaveBeenCalled();
  }
);
