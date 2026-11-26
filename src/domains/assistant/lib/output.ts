import { Buffer } from 'node:buffer';

import type { BriefingEvent } from '../assistant.client';

import { Utf8Size } from './utf8-size';

/** Emergency memory boundaries, not normal answer-length targets. */
export const ASSISTANT_SAFETY_LIMITS = {
  answerBytes: 8 * 1024 * 1024,
  retainedBytes: 64 * 1024 * 1024,
  maximumAnswerBytes: 32 * 1024 * 1024,
  maximumRetainedBytes: 256 * 1024 * 1024,
} as const;

export async function* boundedAssistantEvents(
  events: AsyncIterable<BriefingEvent>,
  limits = {
    maxOutputBytes: Number(ASSISTANT_SAFETY_LIMITS.answerBytes),
    maxRetainedBytes: Number(ASSISTANT_SAFETY_LIMITS.retainedBytes),
  },
  warn?: (data: unknown, message: string) => void,
  signal?: AbortSignal
): AsyncGenerator<BriefingEvent> {
  let markdown = '';
  const size = new Utf8Size();
  let retainedBytes = 0;
  let hasContentEvent = false;
  try {
    for await (const event of events) {
      if (signal?.aborted) return;
      if (event.type === 'briefing_complete' && !event.markdown.trim()) {
        yield { type: 'briefing_error', code: 'malformed_upstream_response', retryable: false };
        return;
      }
      if (event.type === 'briefing_delta' && !event.delta) continue;
      const operations: BriefingEvent[] = [];
      if (event.type === 'briefing_complete' && event.markdown !== markdown) {
        if (hasContentEvent)
          warn?.(
            {
              provider: 'bt-servant',
              streamedBytes: size.bytes,
              finalBytes: Buffer.byteLength(event.markdown),
            },
            'Assistant complete replaced streamed answer'
          );
        operations.push({ type: 'briefing_replace', markdown: event.markdown });
      }
      operations.push(event);
      for (const operation of operations) {
        if (signal?.aborted) return;
        const next =
          operation.type === 'briefing_delta'
            ? markdown + operation.delta
            : operation.type === 'briefing_replace'
              ? operation.markdown
              : markdown;
        const answerBytes =
          operation.type === 'briefing_delta'
            ? size.append(operation.delta)
            : operation.type === 'briefing_replace'
              ? size.replace(operation.markdown)
              : size.bytes;
        retainedBytes += Buffer.byteLength(JSON.stringify(operation));
        if (answerBytes > limits.maxOutputBytes || retainedBytes > limits.maxRetainedBytes) {
          warn?.(
            { provider: 'bt-servant', answerBytes, retainedBytes, ...limits },
            'Assistant output safety limit exceeded'
          );
          yield { type: 'briefing_error', code: 'response_safety_limit', retryable: false };
          return;
        }
        markdown = next;
        yield operation.type === 'briefing_error' && operation.retryAfter !== undefined
          ? {
              ...operation,
              retryAfter: Math.min(86_400, Math.max(0, Math.floor(operation.retryAfter))),
            }
          : operation;
        hasContentEvent = true;
      }
      if (event.type === 'briefing_complete' || event.type === 'briefing_error') return;
    }
    if (!signal?.aborted)
      yield { type: 'briefing_error', code: 'malformed_upstream_response', retryable: false };
  } catch {
    yield { type: 'briefing_error', code: 'temporarily_unavailable', retryable: true };
  }
}
