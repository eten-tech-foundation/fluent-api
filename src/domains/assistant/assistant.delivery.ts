import type { TurnContext } from './assistant.turn.types';
import type { PublicBriefingEvent } from './assistant.types';

import { loadReceiptKey, TurnReceipts } from './assistant.receipts';
import { TURN_PROTOCOL } from './assistant.turn.types';

interface IntegrityMetadata {
  protocol?: typeof TURN_PROTOCOL;
  contextReceipt?: string;
  operationId?: string;
  prefix?: { sequence: number; complete: boolean; receipt: string };
  continuationUnavailable?: 'temporarily_unavailable' | 'context_too_large';
}

/** Sign on authorized delivery, never in shared producers/cache artifacts.
 * First content is immediate; subsequent commits coalesce at 256 UTF-16 units.
 * Replacements commit the entire current answer immediately.
 * Terminal/error flushes commit pending text and its receipt atomically.
 */
export async function* signBriefingDelivery(
  events: AsyncGenerator<PublicBriefingEvent>,
  actorId: number,
  context: TurnContext | null,
  generationFingerprint = '0'.repeat(64)
): AsyncGenerator<PublicBriefingEvent & IntegrityMetadata> {
  const key = loadReceiptKey();
  const receipts = key && context ? new TurnReceipts(key, actorId, context) : null;
  const unavailable: IntegrityMetadata['continuationUnavailable'] = !key
    ? 'temporarily_unavailable'
    : !context
      ? 'context_too_large'
      : undefined;
  let markdown = '';
  let pending = '';
  let sequence = 0;
  let operationId = '';
  const metadata = (complete: boolean): IntegrityMetadata =>
    unavailable || !receipts
      ? { continuationUnavailable: unavailable }
      : {
          protocol: TURN_PROTOCOL,
          contextReceipt: receipts.contextReceipt(),
          operationId,
          prefix: {
            sequence,
            complete,
            receipt: receipts.prefix(receipts.briefingBinding(generationFingerprint), {
              markdown,
              sequence,
              complete,
            }),
          },
        };
  for await (const event of events) {
    if (event.type === 'briefing_started') {
      operationId = event.attemptId;
      yield { ...event, ...metadata(false) };
      continue;
    }
    if (!receipts || unavailable) {
      yield { ...event, continuationUnavailable: unavailable };
      continue;
    }
    if (event.type === 'briefing_delta') {
      if (!event.delta) continue;
      pending += event.delta;
      if (sequence > 0 && pending.length < 256) continue;
      markdown += pending;
      sequence++;
      yield { ...event, delta: pending, ...metadata(false) };
      pending = '';
      continue;
    }
    if (pending) {
      markdown += pending;
      sequence++;
      yield { type: 'briefing_delta', delta: pending, ...metadata(false) };
      pending = '';
    }
    if (event.type === 'briefing_replace') {
      markdown = event.markdown;
      sequence++;
      yield { ...event, ...metadata(false) };
      continue;
    }
    if (event.type === 'briefing_complete' && event.markdown !== markdown) {
      yield {
        type: 'briefing_error',
        code: 'malformed_upstream_response',
        retryable: false,
        continuationUnavailable: 'temporarily_unavailable',
      };
      return;
    }
    yield { ...event, ...metadata(event.type === 'briefing_complete') };
  }
  // EOF without a terminal is a transport failure. Preserve the last buffered visible text.
  if (pending) {
    markdown += pending;
    sequence++;
    yield { type: 'briefing_delta', delta: pending, ...metadata(false) };
  }
}
