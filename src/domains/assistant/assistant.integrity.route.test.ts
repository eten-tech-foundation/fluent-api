import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PassageContext } from './assistant.repository';

import { resolveTurnContext } from './assistant.context';
import * as receiptModule from './assistant.receipts';
import {
  assistantRouteMocks,
  authenticate,
  config,
  post,
  resetAssistantRouteTestFixture,
  user,
  validBody,
} from './assistant.route.test-fixtures';
import { verifyTurnTranscript } from './assistant.transcript';
import {
  assistantTurnRequestSchema,
  briefingIntegrityMetadataSchema,
} from './assistant.turn.types';

const key = receiptModule.parseReceiptKey({
  ASSISTANT_RECEIPT_KEY_ID: 'delivery-test',
  ASSISTANT_RECEIPT_KEY_HEX: '02'.repeat(32),
})!;
const passage: PassageContext = {
  sourceBible: 'Canonical Source',
  sourceLanguageCode: 'eng',
  verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'server source' }],
  integritySource: {
    organizationId: 1,
    sourceBibleId: 9,
    provider: 'dbl',
    externalId: null,
    pericopeSetId: 3,
    membership: { number: '12', section: null },
    members: [{ id: 1, chapter: 4, verse: 25 }],
  },
};
const context = () =>
  resolveTurnContext({
    projectId: 7,
    passage,
    config,
    outputLanguage: 'en',
    resourceLanguage: 'en',
    groundingInstruction: config.languages.en.grounding.en.instruction,
  })!;
async function delivery(ignore_cache = false) {
  const response = await post({ ...validBody, ignore_cache });
  expect(response.status).toBe(200);
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}
function continuation(events: Awaited<ReturnType<typeof delivery>>) {
  const final = events.at(-1);
  return assistantTurnRequestSchema.parse({
    protocol: 'fluent-turn-v1',
    ...validBody,
    grounding: 'configured',
    contextReceipt: events[0].contextReceipt,
    briefing: { markdown: 'brief', ...final.prefix },
    turns: [],
    submission: {
      kind: 'new',
      turnId: 'turn',
      attemptId: 'attempt',
      input: { text: 'Why?', origin: 'typed' },
    },
  });
}
beforeEach(async () => {
  await resetAssistantRouteTestFixture();
  vi.spyOn(receiptModule, 'loadReceiptKey').mockReturnValue(key);
  vi.mocked(assistantRouteMocks.resolveCanonicalPassage).mockResolvedValue(passage);
  authenticate();
});
afterEach(() => vi.restoreAllMocks());

describe('guarded briefing integrity integration', () => {
  it('does not sign or resolve source before authentication/project authorization', async () => {
    authenticate(false);
    expect((await post(validBody)).status).toBe(404);
    expect(receiptModule.loadReceiptKey).not.toHaveBeenCalled();
    expect(assistantRouteMocks.resolveCanonicalPassage).not.toHaveBeenCalled();
    expect(assistantRouteMocks.findCompletedArtifact).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'signs private/shared delivery (private=%s) against the current actor/context',
    async (privateDelivery) => {
      const events = await delivery(privateDelivery);
      const receipts = new receiptModule.TurnReceipts(key, 17, context());
      expect(events.map((event) => event.type)).toEqual([
        'briefing_started',
        'briefing_delta',
        'briefing_complete',
      ]);
      for (const event of events) {
        expect(
          briefingIntegrityMetadataSchema.safeParse({
            protocol: event.protocol,
            operationId: event.operationId,
            contextReceipt: event.contextReceipt,
            prefix: event.prefix,
          }).success
        ).toBe(true);
      }
      expect(verifyTurnTranscript(receipts, context(), continuation(events), 5).ok).toBe(true);
      expect(
        verifyTurnTranscript(
          new receiptModule.TurnReceipts(key, 18, context()),
          context(),
          continuation(events),
          5
        )
      ).toEqual({ ok: false, code: 'context_changed' });
    }
  );
  it('mints cached actor-specific receipts and verifies after the cache row disappears', async () => {
    vi.mocked(assistantRouteMocks.findCompletedArtifact).mockResolvedValue({
      cacheKey: 'cache',
      markdown: 'brief',
      cacheEpoch: config.cacheEpoch,
      outputContractVersion: 'fluent-widgets-v1',
    });
    const first = await delivery();
    user.id = 18;
    const second = await delivery();
    expect(first[0].contextReceipt).not.toBe(second[0].contextReceipt);
    expect(first.at(-1).prefix.receipt).not.toBe(second.at(-1).prefix.receipt);
    expect(second.at(-1).cacheHit).toBe(true);
    expect(assistantRouteMocks.BtServantClient).not.toHaveBeenCalled();
    vi.mocked(assistantRouteMocks.findCompletedArtifact).mockResolvedValue(null);
    const lookups = vi.mocked(assistantRouteMocks.findCompletedArtifact).mock.calls.length;
    expect(
      verifyTurnTranscript(
        new receiptModule.TurnReceipts(key, 18, context()),
        context(),
        continuation(second),
        5
      ).ok
    ).toBe(true);
    expect(assistantRouteMocks.findCompletedArtifact).toHaveBeenCalledTimes(lookups);
  });
  it('keeps ordinary briefing usable without signing credentials', async () => {
    vi.mocked(receiptModule.loadReceiptKey).mockReturnValue(null);
    const events = await delivery(true);
    expect(events.at(-1)).toMatchObject({
      type: 'briefing_complete',
      markdown: 'brief',
      continuationUnavailable: 'temporarily_unavailable',
    });
    expect(events.every((event) => !event.contextReceipt && !event.prefix)).toBe(true);
  });
  it('changes semantic context for source membership, resource policy and scope revisions', () => {
    const initial = context()!;
    const resolve = (next: PassageContext) =>
      resolveTurnContext({
        projectId: 7,
        passage: next,
        config,
        outputLanguage: 'en',
        resourceLanguage: 'en',
        groundingInstruction: config.languages.en.grounding.en.instruction,
      })!;
    expect(
      resolve({
        ...passage,
        integritySource: {
          ...passage.integritySource!,
          membership: { number: 'next', section: null },
        },
      }).sourceRevision
    ).not.toBe(initial.sourceRevision);
    expect(
      resolve({ ...passage, integritySource: { ...passage.integritySource!, organizationId: 2 } })
        .authorizationScope
    ).not.toBe(initial.authorizationScope);
    expect(
      resolveTurnContext({
        projectId: 7,
        passage,
        config: { ...config, resourcePolicyVersion: 'next' },
        outputLanguage: 'en',
        resourceLanguage: 'en',
        groundingInstruction: config.languages.en.grounding.en.instruction,
      })?.resourcePolicyVersion
    ).toBe('next');
  });
});
