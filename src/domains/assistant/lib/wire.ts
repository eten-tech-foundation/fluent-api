import { Buffer } from 'node:buffer';

import { ASSISTANT_SAFETY_LIMITS } from './output';

/** Whole emitted SSE frame, including id/event/data prefixes and the final blank line.
 * JSON can expand a one-byte control character to six ASCII bytes. The envelope reserve
 * covers bounded receipts, identity, metadata and SSE overhead. This is independent of BT's
 * configurable upstream frame limit; Web mirrors this same emitted-frame ceiling.
 */
export const ASSISTANT_FRAME_BYTES = 6 * ASSISTANT_SAFETY_LIMITS.maximumAnswerBytes + 1_048_576;

export function serializeAssistantFrame(
  event: { type: string },
  id: number,
  maximumBytes: number = ASSISTANT_FRAME_BYTES
): string {
  const frame = `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (Buffer.byteLength(frame) > maximumBytes)
    throw new Error('Assistant emitted frame exceeds limit');
  return frame;
}
