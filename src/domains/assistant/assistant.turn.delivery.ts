import { Buffer } from 'node:buffer';

import type { BriefingEvent } from './assistant.client';
import type { TurnReceipts } from './assistant.receipts';
import type { verifyTurnTranscript } from './assistant.transcript';

import { TURN_LIMITS, TURN_PROTOCOL } from './assistant.turn.types';

type Verified = Extract<ReturnType<typeof verifyTurnTranscript>, { ok: true }>;

/** Enforce the turn contract before either retention, publication or signing. */
export async function* boundedTurnEvents(events: AsyncIterable<BriefingEvent>) {
  let markdown = '';
  try {
    for await (const event of events) {
      if (event.type === 'briefing_delta') {
        const next = markdown + event.delta;
        if (
          next.length > TURN_LIMITS.outputChars ||
          Buffer.byteLength(next) > TURN_LIMITS.outputBytes
        ) {
          yield { type: 'briefing_error', code: 'context_too_large', retryable: false } as const;
          return;
        }
        markdown = next;
        if (event.delta) yield event;
      } else if (event.type === 'briefing_complete') {
        yield event.markdown === markdown
          ? event
          : ({
              type: 'briefing_error',
              code: 'malformed_upstream_response',
              retryable: false,
            } as const);
        return;
      } else {
        const retryAfter = event.retryAfter;
        yield {
          ...event,
          ...(retryAfter === undefined
            ? {}
            : {
                retryAfter: Math.min(86_400, Math.max(0, Math.floor(retryAfter))),
              }),
        };
        return;
      }
    }
    yield {
      type: 'briefing_error',
      code: 'malformed_upstream_response',
      retryable: false,
    } as const;
  } catch {
    yield { type: 'briefing_error', code: 'temporarily_unavailable', retryable: true } as const;
  }
}

/** Each subscriber gets actor-bound receipts; pending text and its receipt commit together. */
export async function* deliverTurn(
  events: AsyncIterable<BriefingEvent>,
  receipts: TurnReceipts,
  verified: Verified,
  operationId: string,
  signal: AbortSignal
) {
  const identity = {
    protocol: TURN_PROTOCOL,
    operationId,
    turnId: verified.request.submission.turnId,
    attemptId: verified.request.submission.attemptId,
  };
  if (signal.aborted) return;
  yield {
    ...identity,
    type: 'turn_started' as const,
    contextReceipt: receipts.contextReceipt(),
    projection: verified.projection.projection,
  };
  let markdown = '';
  let pending = '';
  let sequence = 0;
  const delta = () => {
    markdown += pending;
    const text = pending;
    pending = '';
    sequence++;
    return {
      ...identity,
      type: 'turn_delta' as const,
      delta: text,
      sequence,
      receipt: receipts.prefix(verified.binding, { markdown, sequence, complete: false }),
    };
  };
  for await (const event of events) {
    if (signal.aborted) return;
    if (event.type === 'briefing_delta') {
      pending += event.delta;
      if (sequence === 0 || pending.length >= 256) yield delta();
      continue;
    }
    if (pending) yield delta();
    if (event.type === 'briefing_complete') {
      yield {
        ...identity,
        type: 'turn_complete' as const,
        sequence,
        receipt: receipts.prefix(verified.binding, { markdown, sequence, complete: true }),
      };
    } else {
      yield {
        ...identity,
        type: 'turn_error' as const,
        code: event.code,
        retryable: event.retryable,
        ...(event.retryAfter === undefined ? {} : { retryAfter: event.retryAfter }),
      };
    }
    return;
  }
}
