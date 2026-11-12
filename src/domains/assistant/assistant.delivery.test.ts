import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PublicBriefingEvent } from './assistant.types';

import { signBriefingDelivery } from './assistant.delivery';
import * as receiptModule from './assistant.receipts';
import { turnContextSchema } from './assistant.turn.types';

const context = turnContextSchema.parse(
  JSON.parse(readFileSync(new URL('./fixtures/turn-v1.json', import.meta.url), 'utf8')).context
);
const key = receiptModule.parseReceiptKey({
  ASSISTANT_RECEIPT_KEY_ID: 'key',
  ASSISTANT_RECEIPT_KEY_HEX: '01'.repeat(32),
})!;
const started: PublicBriefingEvent = {
  type: 'briefing_started',
  attemptId: 'operation',
  operationVersion: 'v1',
  cacheEpoch: '1',
  outputContractVersion: 'v1',
  references: ['JHN 1:1'],
};
async function* stream(
  parts: string[],
  terminal: 'complete' | 'error' | 'eof' | 'replacement' = 'complete'
): AsyncGenerator<PublicBriefingEvent> {
  yield started;
  for (const delta of parts) yield { type: 'briefing_delta', delta };
  if (terminal === 'complete' || terminal === 'replacement')
    yield {
      type: 'briefing_complete',
      markdown: terminal === 'replacement' ? 'other' : parts.join(''),
    };
  if (terminal === 'error') yield { type: 'briefing_error', code: 'timed_out', retryable: true };
}
async function collect(parts: string[], terminal: Parameters<typeof stream>[1] = 'complete') {
  vi.spyOn(receiptModule, 'loadReceiptKey').mockReturnValue(key);
  return Array.fromAsync(signBriefingDelivery(stream(parts, terminal), 17, context));
}
afterEach(() => vi.restoreAllMocks());

describe('actor-bound briefing prefix delivery', () => {
  it('commits every delta with an exact accumulated receipt, including flush on error/EOF', async () => {
    for (const terminal of ['complete', 'error', 'eof'] as const) {
      const events = await collect(['first', 'tiny', 'suffix'], terminal);
      const receipts = new receiptModule.TurnReceipts(key, 17, context);
      let markdown = '';
      let sequence = 0;
      for (const event of events) {
        if (event.type === 'briefing_delta') {
          markdown += event.delta;
          sequence++;
        }
        if (event.prefix) {
          expect(event.prefix.sequence).toBe(sequence);
          expect(
            receipts.verifyPrefix(
              { markdown, ...event.prefix },
              receipts.briefingBinding('0'.repeat(64))
            )
          ).toBe(true);
        }
      }
      expect(markdown).toBe('firsttinysuffix');
      expect(events.at(-1)?.prefix?.complete).toBe(terminal === 'complete');
    }
  });
  it('bounds signature count and total prefix hashing under one-character provider frames', async () => {
    const signatures = vi.spyOn(receiptModule.TurnReceipts.prototype, 'prefix');
    for (const char of ['漢', '\u0000']) {
      signatures.mockClear();
      const events = await collect(Array.from({ length: 15_000 }, () => char));
      const deltas = events.filter((event) => event.type === 'briefing_delta');
      expect(deltas.length).toBeLessThanOrEqual(60);
      expect(signatures.mock.calls.length).toBeLessThanOrEqual(62); // start + commits + terminal
      const hashedBytes = signatures.mock.calls.reduce(
        (total, [, prefix]) => total + Buffer.byteLength(JSON.stringify(prefix.markdown)),
        0
      );
      expect(hashedBytes).toBeLessThan(5_600_000);
      expect(events.at(-1)?.prefix?.complete).toBe(true);
      expect(events.every((event) => event.continuationUnavailable === undefined)).toBe(true);
    }
  });
  it('signs answers above the former arbitrary character limit', async () => {
    const events = await collect(['a', 'x'.repeat(15_000), 'tail']);
    expect(
      events
        .filter((e) => e.type === 'briefing_delta')
        .map((e) => e.delta)
        .join('')
    ).toBe(`a${'x'.repeat(15_000)}tail`);
    expect(events.at(-1)).toMatchObject({
      type: 'briefing_complete',
    });
    expect(events.at(-1)?.prefix?.complete).toBe(true);
  });
  it('does not replace committed text with terminal-only text', async () => {
    const events = await collect(['visible'], 'replacement');
    expect(events.at(-1)).toMatchObject({
      type: 'briefing_error',
      code: 'malformed_upstream_response',
    });
    expect(events.some((e) => e.type === 'briefing_complete')).toBe(false);
  });
  it('keeps original event content and cadence without signing config', async () => {
    vi.spyOn(receiptModule, 'loadReceiptKey').mockReturnValue(null);
    const events = await Array.fromAsync(signBriefingDelivery(stream(['a', 'b']), 17, context));
    expect(events.map((e) => e.type)).toEqual([
      'briefing_started',
      'briefing_delta',
      'briefing_delta',
      'briefing_complete',
    ]);
    expect(
      events.every((e) => e.continuationUnavailable === 'temporarily_unavailable' && !e.prefix)
    ).toBe(true);
  });
  it('keeps briefing usable when canonical context exceeds continuation limits', async () => {
    vi.spyOn(receiptModule, 'loadReceiptKey').mockReturnValue(key);
    const events = await Array.fromAsync(signBriefingDelivery(stream(['a']), 17, null));
    expect(events.at(-1)).toMatchObject({
      type: 'briefing_complete',
      markdown: 'a',
      continuationUnavailable: 'context_too_large',
    });
  });
});

it('signs each replacement and still verifies a pre-retract snapshot already in flight', async () => {
  vi.spyOn(receiptModule, 'loadReceiptKey').mockReturnValue(key);
  const raw = async function* (): AsyncGenerator<PublicBriefingEvent> {
    yield started;
    yield { type: 'briefing_delta', delta: 'visible provisional' };
    yield { type: 'briefing_replace', markdown: '' };
    yield { type: 'briefing_delta', delta: 'new answer' };
    yield { type: 'briefing_replace', markdown: 'authoritative final' };
    yield { type: 'briefing_complete', markdown: 'authoritative final' };
  };
  const events = await Array.fromAsync(signBriefingDelivery(raw(), 17, context));
  const receipts = new receiptModule.TurnReceipts(key, 17, context);
  let markdown = '';
  for (const event of events) {
    if (event.type === 'briefing_delta') markdown += event.delta;
    if (event.type === 'briefing_replace') markdown = event.markdown;
    expect(
      receipts.verifyPrefix(
        { markdown, ...event.prefix! },
        receipts.briefingBinding('0'.repeat(64))
      )
    ).toBe(true);
  }
  expect(events.map((event) => event.prefix?.sequence)).toEqual([0, 1, 2, 3, 4, 4]);
  expect(
    receipts.verifyPrefix(
      { markdown: 'visible provisional', ...events[1].prefix! },
      receipts.briefingBinding('0'.repeat(64))
    )
  ).toBe(true);
});
