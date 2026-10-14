import { describe, expect, it } from 'vitest';

import { BtServantClient } from './assistant.client';

const options = {
  baseUrl: 'https://bt.invalid',
  engineKey: 'fixture-only',
  org: 'fluent',
  connectMs: 100,
  idleMs: 100,
  totalMs: 100,
  maxOutputBytes: 100,
  maxFrameBytes: 1_000,
};

async function stream(sse: string) {
  const client = new BtServantClient({
    ...options,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        })
      ),
  });
  const events = [];
  for await (const event of client.stream({
    userId: 'fluent_1',
    message: 'x',
    responseLanguageHint: 'en',
  }))
    events.push(event);
  return events;
}

describe('bt multi-response completion contract', () => {
  it('matches streamed progress using one newline between responses', async () => {
    const sse =
      'data: {"type":"progress","text":"first"}\n\ndata: {"type":"progress","text":"\\n"}\n\ndata: {"type":"progress","text":"second"}\n\ndata: {"type":"complete","response":{"responses":["first","second"]}}\n\n';
    expect(await stream(sse)).toEqual([
      { type: 'briefing_delta', delta: 'first' },
      { type: 'briefing_delta', delta: '\n' },
      { type: 'briefing_delta', delta: 'second' },
      { type: 'briefing_complete', markdown: 'first\nsecond' },
    ]);
  });

  it('emits complete-only responses as one single-newline delta', async () => {
    const sse = 'data: {"type":"complete","response":{"responses":["first","second"]}}\n\n';
    expect(await stream(sse)).toEqual([
      { type: 'briefing_delta', delta: 'first\nsecond' },
      { type: 'briefing_complete', markdown: 'first\nsecond' },
    ]);
  });
});
