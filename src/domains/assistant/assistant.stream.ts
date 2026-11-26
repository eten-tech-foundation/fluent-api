import type { SSEStreamingApi } from 'hono/streaming';

import { serializeAssistantFrame } from './lib/wire';

/** Keep browser transport alive during activity-only provider work, without exposing that work.
 * Provider idle/total deadlines still govern generation. Comments never affect event ids/receipts.
 */
export async function writeAssistantEvents(
  stream: SSEStreamingApi,
  events: AsyncIterable<{ type: string }>
): Promise<void> {
  let heartbeatWrite: Promise<unknown> | undefined;
  const heartbeat = setInterval(() => {
    // One pending comment at most, including when a slow reader applies backpressure.
    if (heartbeatWrite || stream.aborted || stream.closed) return;
    heartbeatWrite = stream.write(': keepalive\n\n').finally(() => {
      heartbeatWrite = undefined;
    });
  }, 15_000);
  const stop = () => clearInterval(heartbeat);
  stream.onAbort(stop);
  try {
    let id = 0;
    for await (const event of events) {
      if (stream.aborted) return;
      await stream.write(serializeAssistantFrame(event, ++id));
    }
  } finally {
    stop();
  }
}
