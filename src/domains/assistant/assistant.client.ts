import { Buffer } from 'node:buffer';
export type BriefingFailureCode =
  | 'invalid_request'
  | 'unsupported_language'
  | 'context_too_large'
  | 'rate_limited'
  | 'timed_out'
  | 'temporarily_unavailable'
  | 'malformed_upstream_response';

export type BriefingEvent =
  | { type: 'briefing_delta'; delta: string }
  | { type: 'briefing_complete'; markdown: string }
  | { type: 'briefing_error'; code: BriefingFailureCode; retryable: boolean; retryAfter?: number };

interface ClientOptions {
  baseUrl: string;
  engineKey: string;
  org: string;
  connectMs: number;
  idleMs: number;
  totalMs: number;
  maxOutputBytes: number;
  maxFrameBytes: number;
  fetch?: typeof globalThis.fetch;
}

const VALID_ACTIVITY_EVENTS = new Set([
  'status',
  'progress',
  'tool_use',
  'tool_result',
  'keepalive',
  'complete',
  'error',
]);

function failure(
  code: BriefingFailureCode,
  retryable: boolean,
  retryAfter?: number
): BriefingEvent {
  return {
    type: 'briefing_error',
    code,
    retryable,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  if (/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) {
    if (!/^\d+$/.test(normalized)) return undefined;
    const seconds = Number(normalized);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

export class BtServantClient {
  constructor(private readonly options: ClientOptions) {}

  async *stream(
    request: { userId: string; message: string; responseLanguageHint: string },
    signal?: AbortSignal
  ): AsyncGenerator<BriefingEvent> {
    if (signal?.aborted) return;
    const fetcher = this.options.fetch ?? fetch;
    const controller = new AbortController();
    let subscriberCancelled = false;
    let deadlineExpired = false;
    let terminal = false;
    const abortForSubscriber = () => {
      subscriberCancelled = true;
      controller.abort();
    };
    const abortForDeadline = () => {
      if (terminal || subscriberCancelled) return;
      deadlineExpired = true;
      controller.abort();
    };
    signal?.addEventListener('abort', abortForSubscriber, { once: true });
    const total = setTimeout(abortForDeadline, this.options.totalMs);
    const connect = setTimeout(abortForDeadline, this.options.connectMs);
    let idle: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await fetcher(`${this.options.baseUrl}/api/v1/chat/stream`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.engineKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_id: 'fluent-passage-briefing',
          user_id: request.userId,
          message_type: 'text',
          org: this.options.org,
          message: request.message,
          history: [],
          suppress_welcome: true,
          suppress_memory: true,
          response_language_hint: request.responseLanguageHint,
        }),
        signal: controller.signal,
      });
      clearTimeout(connect);
      if (subscriberCancelled) return;
      if (deadlineExpired) {
        terminal = true;
        yield failure('timed_out', true);
        return;
      }
      if (!response.ok || !response.body) {
        terminal = true;
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        yield response.status === 429
          ? failure('rate_limited', true, retryAfter)
          : failure('temporarily_unavailable', true);
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let outputBytes = 0;
      idle = setTimeout(abortForDeadline, this.options.idleMs);
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (subscriberCancelled) return;
        if (deadlineExpired) {
          terminal = true;
          yield failure('timed_out', true);
          return;
        }
        buffer += decoder.decode(bytes, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        if (Buffer.byteLength(buffer) > this.options.maxFrameBytes) {
          terminal = true;
          controller.abort();
          yield failure('malformed_upstream_response', false);
          return;
        }
        for (const frame of frames) {
          if (subscriberCancelled) return;
          if (deadlineExpired) {
            terminal = true;
            yield failure('timed_out', true);
            return;
          }
          if (Buffer.byteLength(frame) > this.options.maxFrameBytes) {
            terminal = true;
            controller.abort();
            yield failure('malformed_upstream_response', false);
            return;
          }
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            terminal = true;
            yield failure('malformed_upstream_response', false);
            return;
          }
          if (!event || typeof event !== 'object' || !('type' in event)) {
            terminal = true;
            yield failure('malformed_upstream_response', false);
            return;
          }
          const eventRecord = event as Record<string, unknown>;
          if (typeof eventRecord.type !== 'string') {
            terminal = true;
            yield failure('malformed_upstream_response', false);
            return;
          }
          const isValidActivity = VALID_ACTIVITY_EVENTS.has(eventRecord.type);
          if (isValidActivity) {
            clearTimeout(idle);
            idle = setTimeout(abortForDeadline, this.options.idleMs);
          }
          if (eventRecord.type === 'progress' && typeof eventRecord.text === 'string') {
            outputBytes += Buffer.byteLength(eventRecord.text);
            if (outputBytes > this.options.maxOutputBytes) {
              terminal = true;
              controller.abort();
              yield failure('context_too_large', false);
              return;
            }
            accumulated += eventRecord.text;
            if (subscriberCancelled) return;
            if (deadlineExpired) {
              terminal = true;
              yield failure('timed_out', true);
              return;
            }
            yield { type: 'briefing_delta', delta: eventRecord.text };
          } else if (eventRecord.type === 'complete') {
            const responseRecord =
              eventRecord.response && typeof eventRecord.response === 'object'
                ? (eventRecord.response as Record<string, unknown>)
                : undefined;
            const responses = responseRecord?.responses;
            const final =
              Array.isArray(responses) && responses.every((value) => typeof value === 'string')
                ? responses.join('\n')
                : null;
            terminal = true;
            if (typeof final !== 'string' || (accumulated.length > 0 && final !== accumulated)) {
              yield failure('malformed_upstream_response', false);
            } else {
              if (accumulated.length === 0 && final.length > 0) {
                const finalBytes = Buffer.byteLength(final);
                if (finalBytes > this.options.maxOutputBytes) {
                  yield failure('context_too_large', false);
                  return;
                }
                accumulated = final;
                if (subscriberCancelled) return;
                if (deadlineExpired) {
                  yield failure('timed_out', true);
                  return;
                }
                yield { type: 'briefing_delta', delta: final };
              }
              if (subscriberCancelled) return;
              if (deadlineExpired) {
                yield failure('timed_out', true);
                return;
              }
              yield { type: 'briefing_complete', markdown: accumulated };
            }
            return;
          } else if (eventRecord.type === 'error') {
            terminal = true;
            yield failure('temporarily_unavailable', true);
            return;
          }
        }
      }
      if (!terminal && !subscriberCancelled) {
        terminal = true;
        yield deadlineExpired
          ? failure('timed_out', true)
          : failure('malformed_upstream_response', false);
      }
    } catch {
      if (subscriberCancelled || terminal) return;
      terminal = true;
      yield failure(deadlineExpired ? 'timed_out' : 'temporarily_unavailable', true);
    } finally {
      clearTimeout(connect);
      clearTimeout(total);
      if (idle) clearTimeout(idle);
      signal?.removeEventListener('abort', abortForSubscriber);
    }
  }
}
