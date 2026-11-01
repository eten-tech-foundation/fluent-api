import { Hono } from 'hono';
import { SSEStreamingApi, streamSSE } from 'hono/streaming';
import { afterEach, expect, it, vi } from 'vitest';

import { BtServantClient } from './assistant.client';
import { writeAssistantEvents } from './assistant.stream';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  ['briefing', false],
  ['briefing', true],
  ['turn', false],
  ['turn', true],
] as const)(
  'keeps %s activity-only waits alive (complete=%s) without changing text/receipts or deadlines',
  async (operation, complete) => {
    vi.useFakeTimers();
    let activity: ReturnType<typeof setInterval>;
    const client = new BtServantClient({
      baseUrl: 'https://bt.invalid',
      engineKey: 'fixture',
      org: 'fluent',
      connectMs: 10000,
      idleMs: 45000,
      totalMs: 180000,
      maxOutputBytes: 60000,
      maxFrameBytes: 1048576,
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              let count = 0;
              activity = setInterval(() => {
                if (complete && ++count === 2) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"type":"progress","text":"answer"}\n\ndata: {"type":"complete","response":{"responses":["answer"]}}\n\n'
                    )
                  );
                  clearInterval(activity);
                  controller.close();
                  return;
                }
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"status","private_tool_data":"never forwarded"}\n\n'
                  )
                );
              }, 30000);
              init?.signal?.addEventListener(
                'abort',
                () => {
                  clearInterval(activity);
                  controller.error(new Error('aborted'));
                },
                { once: true }
              );
            },
          })
        ),
    });
    const events = (async function* () {
      yield { type: `${operation}_started`, receipt: 'unchanged-fixture-receipt' };
      for await (const event of client.stream({
        userId: 'fluent_1',
        message: 'synthetic',
        responseLanguageHint: 'en',
      }))
        yield { ...event, type: event.type.replace('briefing', operation) };
    })();
    const app = new Hono();
    app.get('/', (c) => streamSSE(c, (stream) => writeAssistantEvents(stream, events)));
    const response = await app.request('/');
    const chunks: Array<{ time: number; text: string }> = [];
    const reading = (async () => {
      const reader = response.body!.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        chunks.push({ time: Date.now(), text: new TextDecoder().decode(chunk.value) });
      }
    })();
    await vi.advanceTimersByTimeAsync(60000);
    expect(
      chunks.filter((chunk) => chunk.text === ': keepalive\n\n').length
    ).toBeGreaterThanOrEqual(4);
    expect(chunks.some((chunk) => chunk.text.includes('timed_out'))).toBe(false);
    await vi.advanceTimersByTimeAsync(120000);
    await reading;
    const wire = chunks.map((chunk) => chunk.text).join('');
    expect(wire).toContain(complete ? `event: ${operation}_complete` : '"code":"timed_out"');
    if (complete) expect(wire).toContain('"delta":"answer"');
    expect(wire).toContain('unchanged-fixture-receipt');
    expect(wire).not.toContain('private_tool_data');
    if (!complete) expect(wire).not.toContain(`${operation}_delta`);
    const ids = wire.split('\n').filter((line) => line.startsWith('id: '));
    expect(ids).toEqual(complete ? ['id: 1', 'id: 2', 'id: 3'] : ['id: 1', 'id: 2']);
    for (let index = 1; index < chunks.length; index++)
      expect(chunks[index].time - chunks[index - 1].time).toBeLessThanOrEqual(15000);
    expect(vi.getTimerCount()).toBe(0);
  }
);

it('does not hide a real provider idle timeout behind server comments', async () => {
  vi.useFakeTimers();
  const client = new BtServantClient({
    baseUrl: 'https://bt.invalid',
    engineKey: 'fixture',
    org: 'fluent',
    connectMs: 10000,
    idleMs: 45000,
    totalMs: 180000,
    maxOutputBytes: 60000,
    maxFrameBytes: 1048576,
    fetch: async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), {
              once: true,
            });
          },
        })
      ),
  });
  const app = new Hono();
  app.get('/', (c) =>
    streamSSE(c, (stream) =>
      writeAssistantEvents(
        stream,
        client.stream({ userId: 'fluent_1', message: 'synthetic', responseLanguageHint: 'en' })
      )
    )
  );
  const reading = (await app.request('/')).text();
  await vi.advanceTimersByTimeAsync(45000);
  expect(await reading).toContain('"code":"timed_out"');
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds comment backpressure and clears the timer when a subscriber disconnects', async () => {
  vi.useFakeTimers();
  const transform = new TransformStream();
  const stream = new SSEStreamingApi(transform.writable, transform.readable);
  const write = vi.spyOn(stream, 'write');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events = (async function* () {
    await gate;
    yield { type: 'turn_complete' };
  })();
  const writing = writeAssistantEvents(stream, events);
  await vi.advanceTimersByTimeAsync(60000);
  // The response's internal readable can hold one chunk; at most one more write is pending.
  expect(write.mock.calls.length).toBeLessThanOrEqual(2);
  stream.abort();
  release();
  await writing;
  expect(vi.getTimerCount()).toBe(0);
});
