import type { Context, Next } from 'hono';

import * as HttpStatusCodes from 'stoker/http-status-codes';

import { TURN_LIMITS } from './assistant.turn.types';

/** Count actual incoming bytes, including whitespace/duplicate keys, before JSON validation. */
export async function admitTurnBody(c: Context, next: Next) {
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > TURN_LIMITS.bodyBytes) {
          void reader.cancel().catch(() => {});
          return c.json(
            { code: 'context_too_large', retryable: false },
            HttpStatusCodes.REQUEST_TOO_LONG
          );
        }
        if (result.value.byteLength) chunks.push(result.value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    JSON.parse(text); // Normalize malformed JSON here instead of the validator error envelope.
    c.req.raw = new Request(c.req.raw, { body: text });
  } catch {
    return c.json({ code: 'invalid_request', retryable: false }, HttpStatusCodes.BAD_REQUEST);
  } finally {
    reader?.releaseLock();
  }
  await next();
}
