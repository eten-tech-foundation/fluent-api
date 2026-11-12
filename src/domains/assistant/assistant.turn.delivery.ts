import type { BriefingEvent } from './assistant.client';
import type { TurnReceipts } from './assistant.receipts';
import type { verifyTurnTranscript } from './assistant.transcript';

import { WIDGET_CONTRACT_VERSION } from './assistant.prompt';
import { TURN_PROTOCOL } from './assistant.turn.types';

type Verified = Extract<ReturnType<typeof verifyTurnTranscript>, { ok: true }>;

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
    outputContractVersion: WIDGET_CONTRACT_VERSION,
    contextReceipt: receipts.contextReceipt(),
    projection: verified.projection.projection,
  };
  const signer = receipts.prefixSigner(verified.binding);
  let pending = '';
  let sequence = 0;
  const delta = () => {
    signer.append(pending);
    const text = pending;
    pending = '';
    sequence++;
    return {
      ...identity,
      type: 'turn_delta' as const,
      delta: text,
      sequence,
      receipt: signer.receipt(sequence, false),
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
    if (event.type === 'briefing_replace') {
      signer.replace(event.markdown);
      sequence++;
      yield {
        ...identity,
        type: 'turn_replace' as const,
        markdown: event.markdown,
        sequence,
        receipt: signer.receipt(sequence, false),
      };
      continue;
    }
    if (event.type === 'briefing_complete') {
      yield {
        ...identity,
        type: 'turn_complete' as const,
        sequence,
        receipt: signer.receipt(sequence, true),
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
