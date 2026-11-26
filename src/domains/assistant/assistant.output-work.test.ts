import { Buffer } from 'node:buffer';
import { Hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

import type { BriefingEvent } from './assistant.client';
import type { PublicBriefingEvent } from './assistant.types';

import { signBriefingDelivery } from './assistant.delivery';
import * as receiptModule from './assistant.receipts';
import { verifyTurnTranscript } from './assistant.transcript';
import { deliverTurn } from './assistant.turn.delivery';
import { assistantTurnRequestSchema, turnContextSchema } from './assistant.turn.types';
import { ASSISTANT_SAFETY_LIMITS, boundedAssistantEvents } from './lib/output';
import { Utf8Size } from './lib/utf8-size';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/turn-v1.json', import.meta.url), 'utf8')
);
const context = turnContextSchema.parse(fixture.context);
const key = receiptModule.parseReceiptKey({
  ASSISTANT_RECEIPT_KEY_ID: 'work',
  ASSISTANT_RECEIPT_KEY_HEX: '01'.repeat(32),
})!;
afterEach(() => vi.restoreAllMocks());

it.each(['briefing', 'turn'] as const)(
  'keeps %s scanning and signing linear at the configured 8 MiB ceiling',
  async (operation) => {
    const receipts = new receiptModule.TurnReceipts(key, 17, context);
    vi.spyOn(receiptModule, 'loadReceiptKey').mockReturnValue(key);
    const request = assistantTurnRequestSchema.parse(fixture.request);
    request.contextReceipt = receipts.contextReceipt();
    request.briefing.receipt = receipts.prefix(receipts.briefingBinding(), request.briefing);
    const verified = verifyTurnTranscript(receipts, context, request, 5);
    if (!verified.ok) throw new Error('Invalid work fixture');
    const total = ASSISTANT_SAFETY_LIMITS.answerBytes;
    const chunk = 'x'.repeat(1024);
    const full = 'x'.repeat(total);
    async function* source(): AsyncGenerator<BriefingEvent> {
      for (let offset = 0; offset < total; offset += chunk.length)
        yield { type: 'briefing_delta', delta: chunk };
      yield { type: 'briefing_complete', markdown: full };
    }
    async function* briefing(): AsyncGenerator<PublicBriefingEvent> {
      yield {
        type: 'briefing_started',
        attemptId: 'work',
        operationVersion: 'v1',
        cacheEpoch: '1',
        outputContractVersion: 'fluent-widgets-v1',
        references: ['JHN 1:1'],
      };
      yield* boundedAssistantEvents(source());
    }
    const originalUpdate = Hash.prototype.update;
    let hashBytes = 0;
    vi.spyOn(Hash.prototype, 'update').mockImplementation(function (
      this: Hash,
      data: string | NodeJS.ArrayBufferView,
      encoding?: BufferEncoding
    ) {
      hashBytes += typeof data === 'string' ? data.length * 2 : data.byteLength;
      return typeof data === 'string' && encoding
        ? originalUpdate.bind(this)(data, encoding)
        : originalUpdate.bind(this)(data);
    });
    const copies = vi.spyOn(Hash.prototype, 'copy');
    const originalByteLength = Buffer.byteLength;
    let scannedUnits = 0;
    vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => {
      if (typeof value === 'string') scannedUnits += value.length;
      return originalByteLength(value, encoding);
    });
    const legacy = vi.spyOn(receiptModule.TurnReceipts.prototype, 'prefix');
    const events =
      operation === 'briefing'
        ? signBriefingDelivery(briefing(), 17, context)
        : deliverTurn(
            boundedAssistantEvents(source()),
            receipts,
            verified,
            'work',
            new AbortController().signal
          );
    let commits = 0;
    let terminal: { sequence: number; complete: boolean; receipt: string } | undefined;
    for await (const event of events) {
      if (event.type === 'briefing_delta' || event.type === 'turn_delta') commits++;
      if (event.type === 'briefing_complete' && 'prefix' in event) terminal = event.prefix;
      if (event.type === 'turn_complete')
        terminal = { sequence: event.sequence, complete: true, receipt: event.receipt };
    }
    expect(commits).toBe(total / chunk.length); // retain smooth, immediate visible commits
    expect(legacy).not.toHaveBeenCalled();
    expect(scannedUnits).toBeLessThan(total * 8);
    // SHA-256 copying/final padding touches at most two fixed-size blocks per receipt.
    expect(hashBytes + copies.mock.calls.length * 128).toBeLessThan(total * 3);
    vi.restoreAllMocks();
    expect(terminal).toBeDefined();
    expect(
      receipts.verifyPrefix(
        { markdown: full, ...terminal! },
        operation === 'briefing' ? receipts.briefingBinding('0'.repeat(64)) : verified.binding
      )
    ).toBe(true);
  }
);

it('counts appends exactly when surrogate pairs cross boundaries and replacements reset them', () => {
  const size = new Utf8Size();
  let text = '';
  for (const part of ['a', '\uD83D', '', '\uDE00', '\uD800', '界', '\uDC00']) {
    text += part;
    expect(size.append(part)).toBe(Buffer.byteLength(text));
  }
  expect(size.replace('')).toBe(0);
  expect(size.append('new')).toBe(3);
});
