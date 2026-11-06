import { expect, it } from 'vitest';

import { BtServantClient } from './assistant.client';

it.each(['\n', '\r\n', '\r'])('accepts SSE line ending %j split at every byte', async (ending) => {
  const wire = `data: {"type":"progress","text":"answer"}${ending}${ending}data: {"type":"complete","response":{"responses":["answer"]}}${ending}${ending}`;
  const client = new BtServantClient({
    baseUrl: 'https://bt.invalid',
    engineKey: 'fixture',
    org: 'fluent',
    connectMs: 1000,
    idleMs: 1000,
    totalMs: 1000,
    maxOutputBytes: 20,
    maxFrameBytes: 1000,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const character of wire) controller.enqueue(new TextEncoder().encode(character));
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
  expect(events).toEqual([
    { type: 'briefing_delta', delta: 'answer' },
    { type: 'briefing_complete', markdown: 'answer' },
  ]);
});
