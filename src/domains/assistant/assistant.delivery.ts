import type { TurnContext } from './assistant.turn.types';
import type { PublicBriefingEvent } from './assistant.types';

import { loadReceiptKey, TurnReceipts } from './assistant.receipts';
import { TURN_LIMITS } from './assistant.turn.types';

interface IntegrityMetadata {
  protocol?: 'fluent-turn-v1';
  contextReceipt?: string;
  operationId?: string;
  prefix?: { sequence: number; complete: boolean; receipt: string };
  continuationUnavailable?: 'temporarily_unavailable' | 'context_too_large';
}

/** Sign on authorized delivery, never in shared producers/cache artifacts.
 * First content is immediate; subsequent commits coalesce at 256 UTF-16 units.
 * At most 60 content signatures + completion per bounded 15,000-unit output;
 * fewer than 5.6 MB of canonical prefix hashing, including worst-case JSON escaping.
 * Terminal/error flushes commit pending text and its receipt atomically.
 */
export async function* signBriefingDelivery(
  events: AsyncGenerator<PublicBriefingEvent>,
  actorId: number,
  context: TurnContext | null
): AsyncGenerator<PublicBriefingEvent & IntegrityMetadata> {
  const key = loadReceiptKey();
  const receipts = key && context ? new TurnReceipts(key, actorId, context) : null;
  let unavailable: IntegrityMetadata['continuationUnavailable'] = !key
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
          protocol: 'fluent-turn-v1',
          contextReceipt: receipts.contextReceipt(),
          operationId,
          prefix: {
            sequence,
            complete,
            receipt: receipts.prefix(receipts.briefingBinding(), { markdown, sequence, complete }),
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
      if (
        markdown.length > TURN_LIMITS.outputChars ||
        new TextEncoder().encode(markdown).byteLength > TURN_LIMITS.outputBytes
      )
        unavailable = 'context_too_large';
      yield { ...event, delta: pending, ...metadata(false) };
      pending = '';
      continue;
    }
    if (pending) {
      markdown += pending;
      sequence++;
      if (
        markdown.length > TURN_LIMITS.outputChars ||
        new TextEncoder().encode(markdown).byteLength > TURN_LIMITS.outputBytes
      )
        unavailable = 'context_too_large';
      yield { type: 'briefing_delta', delta: pending, ...metadata(false) };
      pending = '';
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
    if (
      markdown.length > TURN_LIMITS.outputChars ||
      new TextEncoder().encode(markdown).byteLength > TURN_LIMITS.outputBytes
    )
      unavailable = 'context_too_large';
    yield { type: 'briefing_delta', delta: pending, ...metadata(false) };
  }
}
